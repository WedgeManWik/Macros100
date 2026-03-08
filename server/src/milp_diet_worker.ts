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

    // Calorie Slack - EXTREME penalty for deficit
    model.constraints.bal_energy = { equal: targetCalories };
    model.variables.en_def = { score: -100000, bal_energy: 1 };
    model.variables.en_ex = { score: -1000, bal_energy: -1 };

    // Macro Slacks - VERY SOFT
    ['protein', 'fat', 'carbs'].forEach(m => {
        const target = (m === 'protein' ? proteinTarget : (m === 'fat' ? fatTarget : carbTarget));
        model.constraints[`bal_${m}`] = { equal: target };
        model.variables[`${m}_def`] = { score: -10, [`bal_${m}`]: 1 };
        model.variables[`${m}_ex`] = { score: -10, [`bal_${m}`]: -1 };
    });

    const NUTRIENT_REWARD = 10000000;

    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        if (config.target <= 0) return;

        model.variables[`cov_${k}`] = { score: NUTRIENT_REWARD, [`lim_cov_${k}`]: 1, [`track_cov_${k}`]: -1 };
        model.constraints[`lim_cov_${k}`] = { max: 1.0 };
        model.constraints[`track_cov_${k}`] = { min: 0 };

        if (config.max) {
            model.variables[`over_${k}`] = { score: -10, [`track_max_${k}`]: -1 };
            model.constraints[`track_max_${k}`] = { max: config.max };
        }
    });

    foods.forEach((f: Food, idx: number) => {
        const varName = `f_${idx}`;
        const foodVar: any = {
            score: -0.0001,
            bal_energy: f.calories,
            bal_protein: f.protein,
            bal_fat: f.fat,
            bal_carbs: f.carbs
        };

        Object.keys(nutrientConfig).forEach(k => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
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

function finish(foods: Food[], results: any) {
    const genome: Record<string, number> = {};
    foods.forEach((f: Food, idx: number) => {
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
}

function run() {
    const timeout = setTimeout(() => {
        console.error("Worker Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, 20000);

    try {
        const likedFoods = details.likedFoods || [];
        const mustHaveNames = new Set((details.mustHaveFoods || []).map((m: any) => m.name));

        let allowed = FOOD_DATABASE.filter((f: Food) => {
            if (mustHaveNames.has(f.name)) return true;
            if (likedFoods.length === 0) return true;
            
            const nameLower = f.name.toLowerCase();
            return likedFoods.some((l: string) => {
                const lLower = l.toLowerCase();
                if (nameLower === lLower) return true;
                const escapedL = lLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const strictRegex = new RegExp(`\\b${escapedL}\\b`, 'i');
                if (strictRegex.test(nameLower)) {
                    if (l.length < 7) return nameLower.length < l.length + 10;
                    return true;
                }
                return false;
            });
        });

        if (allowed.length === 0 && likedFoods.length === 0) {
            allowed = [...FOOD_DATABASE];
        }

        if (allowed.length > 35) {
            const bestForNutrient = new Set<string>();
            essentialKeys.forEach((k: string) => {
                const target = nutrientConfig[k].target;
                if (target <= 0) return;
                const sortedForK = [...allowed].sort((a, b) => {
                    const valA = (k === 'energy' ? a.calories : k === 'protein' ? a.protein : k === 'carbs' ? a.carbs : k === 'fat' ? a.fat : (a.nutrients[k] as any || 0));
                    const valB = (k === 'energy' ? b.calories : k === 'protein' ? b.protein : k === 'carbs' ? b.carbs : k === 'fat' ? b.fat : (b.nutrients[k] as any || 0));
                    return (valB / target) / (b.calories / 100 || 1) - (valA / target) / (a.calories / 100 || 1);
                });
                if (sortedForK[0]) bestForNutrient.add(sortedForK[0].name);
                if (sortedForK[1]) bestForNutrient.add(sortedForK[1].name);
            });

            const scored = allowed.map((f: Food) => {
                let density = 0;
                essentialKeys.forEach((k: string) => {
                    const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
                    const target = nutrientConfig[k].target;
                    if (target > 0) density += Math.min(1.0, (val / target) / (f.calories / 100 || 1));
                });
                return { f, score: density };
            });
            scored.sort((a: any, b: any) => b.score - a.score);

            const finalAllowedSet = new Set<string>();
            allowed.forEach((f: Food) => { if (mustHaveNames.has(f.name)) finalAllowedSet.add(f.name); });
            const bfnList = Array.from(bestForNutrient);
            for (let i = 0; i < bfnList.length && finalAllowedSet.size < 25; i++) finalAllowedSet.add(bfnList[i]);
            for (let i = 0; i < scored.length && finalAllowedSet.size < 35; i++) finalAllowedSet.add(scored[i].f.name);
            allowed = FOOD_DATABASE.filter((f: Food) => finalAllowedSet.has(f.name));
        }

        parentPort?.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: 'Phase 1: Selection' } });
        const phase1Results: any = solver.Solve(buildModel(allowed, false));
        
        const candidateMap = new Map<string, Food>();
        allowed.forEach((f: Food, idx: number) => {
            const amount = phase1Results[`f_${idx}`] || 0;
            if (amount > 0.01) candidateMap.set(f.name, f);
        });
        
        allowed.forEach((f: Food) => { if (mustHaveNames.has(f.name)) candidateMap.set(f.name, f); });

        let usefulFoods = Array.from(candidateMap.values());
        if (usefulFoods.length > 18) {
            usefulFoods.sort((a, b) => {
                const idxA = allowed.findIndex((f: Food) => f.name === a.name);
                const idxB = allowed.findIndex((f: Food) => f.name === b.name);
                const amtA = idxA >= 0 ? phase1Results[`f_${idxA}`] || 0 : 0;
                const amtB = idxB >= 0 ? phase1Results[`f_${idxB}`] || 0 : 0;
                return amtB - amtA;
            });
            usefulFoods = usefulFoods.slice(0, 18);
        }

        parentPort?.postMessage({ type: 'progress', gen: 1, accuracy: 50, telemetry: { trialInfo: 'Phase 2: Optimization' } });
        const model = buildModel(usefulFoods, true);
        model.options.timeout = 10000;
        const results = solver.Solve(model);
        clearTimeout(timeout);
        finish(usefulFoods, results);

    } catch (err: any) {
        clearTimeout(timeout);
        console.error("FATAL: " + err.stack);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
