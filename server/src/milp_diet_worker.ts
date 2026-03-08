import { parentPort, workerData } from 'worker_threads';
import * as lpSolver from 'javascript-lp-solver';
import { Food } from './types.js';

const solver: any = (lpSolver as any).default || lpSolver;

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const foodMap = new Map<string, Food>();
FOOD_DATABASE.forEach((f: Food) => foodMap.set(f.name, f));

function buildModel(foods: Food[], useBinaries: boolean) {
    const model: any = {
        optimize: "score",
        opType: "max",
        constraints: {},
        variables: {},
        options: { timeout: 10000 }
    };

    if (useBinaries) model.binaries = {};

    const nutrientReward = 100000;

    model.constraints.bal_energy = { equal: targetCalories };
    model.variables.en_def = { score: -1000, bal_energy: 1 };
    model.variables.en_ex = { score: -1000, bal_energy: -1 };
    model.variables.en_free_def = { score: 1000, bal_energy: 1, lim_en_free_def: 1 };
    model.constraints.lim_en_free_def = { max: 70 };
    model.variables.en_free_ex = { score: 1000, bal_energy: -1, lim_en_free_ex: 1 };
    model.constraints.lim_en_free_ex = { max: 70 };

    ['protein', 'fat', 'carbs'].forEach(m => {
        const target = (m === 'protein' ? proteinTarget : (m === 'fat' ? fatTarget : carbTarget));
        model.constraints[`bal_${m}`] = { equal: target };
        model.variables[`${m}_def`] = { score: -500, [`bal_${m}`]: 1 };
        model.variables[`${m}_ex`] = { score: -500, [`bal_${m}`]: -1 };
    });

    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        if (config.target <= 0) return;
        model.variables[`cov_${k}`] = { score: nutrientReward, [`lim_cov_${k}`]: 1, [`track_cov_${k}`]: -1 };
        model.constraints[`lim_cov_${k}`] = { max: 1.0 };
        model.constraints[`track_cov_${k}`] = { min: 0 };
        if (config.max) {
            model.variables[`over_${k}`] = { score: -nutrientReward * 10, [`track_max_${k}`]: -1 };
            model.constraints[`track_max_${k}`] = { max: config.max };
        }
    });

    foods.forEach((f: Food, idx: number) => {
        const varName = `f_${idx}`;
        const foodVar: any = {
            score: -0.1,
            bal_energy: f.calories,
            bal_protein: f.protein,
            bal_fat: f.fat,
            bal_carbs: f.carbs
        };

        Object.keys(nutrientConfig).forEach(k => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] || 0));
            if (nutrientConfig[k].essential && nutrientConfig[k].target > 0) {
                foodVar[`track_cov_${k}`] = val / nutrientConfig[k].target;
            }
            if (nutrientConfig[k].max) {
                foodVar[`track_max_${k}`] = val;
            }
        });

        const mustHave = details.mustHaveFoods ? details.mustHaveFoods.find((m: any) => m.name === f.name) : null;
        const minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
        let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : 
                  ((details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? (details.customMaxAmounts[f.name] / 100) : (f.maxAmount / 100));
        if (maxVal < minVal) maxVal = minVal;

        if (useBinaries) {
            const binName = `u_${idx}`;
            model.binaries[binName] = 1;
            model.constraints[`min_b_${idx}`] = { min: 0 };
            model.constraints[`max_b_${idx}`] = { max: 0 };
            foodVar[`min_b_${idx}`] = 1;
            foodVar[`max_b_${idx}`] = 1;
            model.variables[binName] = { [`min_b_${idx}`]: -minVal, [`max_b_${idx}`]: -maxVal };
            if (mustHave) {
                model.constraints[`force_${idx}`] = { equal: 1 };
                model.variables[binName][`force_${idx}`] = 1;
            }
        } else {
            model.constraints[`lim_${idx}`] = { max: maxVal };
            foodVar[`lim_${idx}`] = 1;
        }
        model.variables[varName] = foodVar;
    });

    return model;
}

function run() {
    const timeout = setTimeout(() => {
        console.error("Worker Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, 20000);

    try {
        let allowed = FOOD_DATABASE.filter((f: Food) => {
            if (details.likedFoods && details.likedFoods.length > 0 && !details.likedFoods.includes(f.name)) {
                if (details.mustHaveFoods && details.mustHaveFoods.some((m: any) => m.name === f.name)) return true;
                return false;
            }
            return true;
        });

        if (allowed.length === 0) {
            allowed = FOOD_DATABASE.slice(0, 50); 
        }

        if (allowed.length > 50) {
            const scored = allowed.map((f: Food) => {
                let nutrientDensity = 0;
                essentialKeys.forEach((k: string) => {
                    const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] || 0));
                    const target = nutrientConfig[k].target;
                    if (target > 0) nutrientDensity += (val / target);
                });
                const score = nutrientDensity / (f.calories / 100 || 1);
                return { f, score };
            });
            scored.sort((a: any, b: any) => {
                if (isNaN(a.score)) return 1;
                if (isNaN(b.score)) return -1;
                return b.score - a.score;
            });
            
            const mustHaveNames = new Set((details.mustHaveFoods || []).map((m: any) => m.name));
            const topFoods = scored.slice(0, 40).map((s: any) => s.f);
            
            const finalAllowed = [...topFoods];
            allowed.forEach((f: Food) => {
                if (mustHaveNames.has(f.name) && !finalAllowed.some(fa => fa.name === f.name)) {
                    finalAllowed.push(f);
                }
            });
            allowed = finalAllowed;
        }

        parentPort?.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: 'Phase 1: Selection' } });

        const phase1Results: any = solver.Solve(buildModel(allowed, false));

        const candidates: { f: Food, amount: number }[] = [];
        allowed.forEach((f: Food, idx: number) => {
            const amount = phase1Results[`f_${idx}`] || 0;
            const mustHave = details.mustHaveFoods ? details.mustHaveFoods.find((m: any) => m.name === f.name) : null;
            if (amount > 0.001 || mustHave) candidates.push({ f, amount });
        });
        candidates.sort((a: any, b: any) => b.amount - a.amount);
        let usefulFoods = candidates.slice(0, 30).map(c => c.f);

        if (usefulFoods.length === 0) {
            usefulFoods = allowed.slice(0, 30);
        }

        parentPort?.postMessage({ type: 'progress', gen: 1, accuracy: 50, telemetry: { trialInfo: 'Phase 2: Optimization' } });

        const results: any = solver.Solve(buildModel(usefulFoods, true));

        const genome: Record<string, number> = {};
        usefulFoods.forEach((f: Food, idx: number) => {
            genome[f.name] = Math.round((results[`f_${idx}`] || 0) * 100);
        });

        const totals: any = { energy: 0, protein: 0, carbs: 0, fat: 0 };
        Object.keys(nutrientConfig).forEach(k => totals[k] = 0);
        for (const name in genome) {
            const amt = genome[name];
            const f = foodMap.get(name);
            if (!f || amt <= 0) continue;
            const r = amt / 100;
            totals.energy += r * f.calories;
            totals.protein += r * f.protein;
            totals.carbs += r * f.carbs;
            totals.fat += r * f.fat;
            if (f.nutrients) {
                for (const n in f.nutrients) {
                    if (totals[n] !== undefined) totals[n] += r * (f.nutrients as any)[n];
                }
            }
        }

        let met = 0;
        essentialKeys.forEach((k: string) => {
            if (totals[k] / (nutrientConfig[k].target || 1) >= 0.95) met++;
        });

        clearTimeout(timeout);
        parentPort?.postMessage({ 
            type: 'result', 
            result: {
                genome,
                targetCalories,
                actualCalories: Math.round(totals.energy),
                accuracy: Math.round((met / essentialKeys.length) * 1000) / 10,
                macros: { protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat) }
            }
        });
    } catch (err: any) {
        clearTimeout(timeout);
        console.error("FATAL: " + err.stack);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
