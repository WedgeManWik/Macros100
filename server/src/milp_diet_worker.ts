import { parentPort, workerData } from 'worker_threads';
// @ts-ignore
import glpkModule from 'glpk.js/node';
import { Food } from './types.js';

function log(msg: string) {
    console.log(`[MILP Worker] ${msg}`);
}

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const modelType = details.algoModel || 'beast';
log(`Worker starting in ${modelType.toUpperCase()} mode (LEAN & DEEP)...`);

const foodMap = new Map<string, Food>();
FOOD_DATABASE.forEach((f: Food) => foodMap.set(f.name, f));

log("Awaiting GLPK module initialization...");
const GLPK_PROMISE = (glpkModule as any)();

/**
 * NUTRIENT SCORING:
 * Sum of percentages capped at 1.0 (100%) per nutrient.
 */
function calculateNutrientScore(totals: any) {
    let score = 0;
    essentialKeys.forEach((k: string) => {
        const target = nutrientConfig[k].target || 1;
        const pct = (totals[k] || 0) / target;
        score += Math.min(1.0, pct);
    });
    return score;
}

/**
 * Extract totals from solver results
 */
function getTotalsFromVars(vars: any, pool: Food[]) {
    const totals: any = { energy: 0, protein: 0, carbs: 0, fat: 0 };
    Object.keys(nutrientConfig).forEach(k => totals[k] = 0);
    
    pool.forEach((f, i) => {
        const amt = vars[`f_${i}`] || 0;
        if (amt <= 0) return;
        totals.energy += amt * f.calories;
        totals.protein += amt * f.protein;
        totals.carbs += amt * f.carbs;
        totals.fat += amt * f.fat;
        if (f.nutrients) {
            for (const n in f.nutrients) {
                if (totals[n] !== undefined) totals[n] += amt * (f.nutrients[n] || 0);
            }
        }
    });
    return totals;
}

async function solveGLPK(foods: Food[], isMILP: boolean, timeLimit: number) {
    const glp = await GLPK_PROMISE;
    
    const vars: any[] = [];
    const constraints: any[] = [];
    const binaries: string[] = [];
    const objectiveVars: any[] = [];

    // --- 1. SLACK VARIABLES ---
    vars.push({ name: 'cal_def', lb: 0, ub: 10000, type: glp.GLP_DB });
    objectiveVars.push({ name: 'cal_def', coef: -1000000000000 });

    ['protein', 'fat', 'carbs'].forEach(m => {
        vars.push({ name: `${m}_def`, lb: 0, ub: 1000, type: glp.GLP_DB });
        vars.push({ name: `${m}_ex`, lb: 0, ub: 1000, type: glp.GLP_DB });
        objectiveVars.push({ name: `${m}_def`, coef: -1000000000 });
        objectiveVars.push({ name: `${m}_ex`, coef: -1000000000 });
    });

    // --- 2. NUTRIENT VARIABLES (0-100%) ---
    essentialKeys.forEach((k: string) => {
        vars.push({ name: `cov_${k}`, lb: 0, ub: 1.0, type: glp.GLP_DB });
        objectiveVars.push({ name: `cov_${k}`, coef: 100000 }); 
    });

    vars.push({ name: 'min_coverage', lb: 0, ub: 1.0, type: glp.GLP_DB });
    objectiveVars.push({ name: 'min_coverage', coef: 1000000 });

    // --- 3. FOOD VARIABLES & BOUNDARIES ---
    foods.forEach((f, i) => {
        const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
        const customMax = details.customMaxAmounts?.[f.name];
        
        let minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
        let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : 
                     (customMax !== undefined ? (customMax / 100) : (f.maxAmount / 100));
        
        if (maxVal < minVal) maxVal = minVal;

        vars.push({ name: `f_${i}`, lb: mustHave ? minVal : 0, ub: maxVal, type: glp.GLP_DB });
        objectiveVars.push({ name: `f_${i}`, coef: f.calories * 0.001 }); 

        if (isMILP) {
            vars.push({ name: `u_${i}`, lb: 0, ub: 1, type: glp.GLP_DB });
            binaries.push(`u_${i}`);
            constraints.push({ name: `min_bound_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -minVal }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
            constraints.push({ name: `max_bound_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -maxVal }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
            if (mustHave) constraints.push({ name: `force_${i}`, vars: [{ name: `u_${i}`, coef: 1 }], bnds: { type: glp.GLP_FX, lb: 1, ub: 1 } });
        }
    });

    // --- 4. CONSTRAINTS ---
    constraints.push({
        name: 'cal_min',
        vars: [...foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })), { name: 'cal_def', coef: 1 }],
        bnds: { type: glp.GLP_LO, lb: targetCalories, ub: 0 }
    });
    constraints.push({
        name: 'cal_max',
        vars: foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })),
        bnds: { type: glp.GLP_UP, lb: 0, ub: targetCalories + 50 }
    });

    const macroTargets = [{ name: 'protein', val: proteinTarget }, { name: 'fat', val: fatTarget }, { name: 'carbs', val: carbTarget }];
    macroTargets.forEach(m => {
        constraints.push({
            name: `macro_${m.name}`,
            vars: [...foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] })), { name: `${m.name}_def`, coef: 1 }, { name: `${m.name}_ex`, coef: -1 }],
            bnds: { type: glp.GLP_FX, lb: m.val, ub: m.val }
        });
    });

    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        const foodCoeffs = foods.map((f, i) => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
            return { name: `f_${i}`, coef: val / (config.target || 1) };
        });
        constraints.push({ name: `link_cov_${k}`, vars: [...foodCoeffs, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
        constraints.push({ name: `link_min_${k}`, vars: [{ name: 'min_coverage', coef: 1 }, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
        if (config.max) {
            constraints.push({ name: `max_${k}`, vars: foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) })), bnds: { type: glp.GLP_UP, lb: 0, ub: config.max } });
        }
    });

    return await glp.solve({
        name: 'DietPlanner',
        objective: { direction: glp.GLP_MAX, name: 'score', vars: objectiveVars },
        subjectTo: constraints, bounds: vars, binaries: binaries,
        options: { presol: true, tmlim: timeLimit }
    });
}

function evaluateDiet(genome: Record<string, number>) {
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
        if (f.nutrients) for (const n in f.nutrients) if (totals[n] !== undefined) totals[n] += r * (f.nutrients[n] || 0);
    }
    let metCount = 0;
    essentialKeys.forEach((k: string) => { if (totals[k] / (nutrientConfig[k].target || 1) >= 0.95) metCount++; });
    return { accuracy: Math.round((metCount / essentialKeys.length) * 1000) / 10, totals, genome, score: calculateNutrientScore(totals) };
}

async function run() {
    // LEAN & DEEP Strategy: Moderate pool sizes (30-45) to ensure solver speed and accuracy,
    // but massive trial counts to explore more combinations.
    const configs: Record<string, any> = {
        beast: { specs: 10, trials: 1000, subset: 30, refinements: 10, milpLimit: 10, timeout: 120000 },
        titan: { specs: 15, trials: 5000, subset: 35, refinements: 20, milpLimit: 15, timeout: 240000 },
        olympian: { specs: 20, trials: 15000, subset: 40, refinements: 30, milpLimit: 30, timeout: 480000 },
        god: { specs: 25, trials: 40000, subset: 45, refinements: 40, milpLimit: 60, timeout: 900000 }
    };
    
    const cfg = configs[modelType] || configs.beast;

    const totalTimeout = setTimeout(() => {
        log("Worker Global Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, cfg.timeout);

    try {
        const likedFoodsPool = FOOD_DATABASE.filter((f: Food) => {
            const liked = details.likedFoods || [];
            if (liked.length === 0) return true;
            const nameLower = f.name.toLowerCase();
            return liked.some((l: string) => {
                const lLower = l.toLowerCase();
                if (nameLower === lLower) return true;
                const escapedL = lLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedL}\\b`, 'i');
                return regex.test(nameLower);
            });
        });
        const mustHaveFoods = FOOD_DATABASE.filter((f: Food) => (details.mustHaveFoods || []).some((m: any) => m.name === f.name));
        
        log(`User Selection Pool: ${likedFoodsPool.length} foods.`);

        // 1. Identify Specialist Pool (Keep it small to maintain trial diversity)
        parentPort?.postMessage({ type: 'progress', gen: 2, accuracy: 0, telemetry: { trialInfo: "Ranking User Selections..." } });
        
        const specialistsPool: Food[] = [];
        const seenSpecialists = new Set<string>();
        
        essentialKeys.forEach((k: string) => {
            const sorted = [...likedFoodsPool].sort((a, b) => {
                const getVal = (food: Food) => {
                    if (k === 'energy') return food.calories;
                    if (k === 'protein') return food.protein;
                    if (k === 'carbs') return food.carbs;
                    if (k === 'fat') return food.fat;
                    return (food.nutrients[k] as any) || 0;
                };
                return (getVal(b) / (b.calories || 1)) - (getVal(a) / (a.calories || 1));
            });
            for (let i = 0; i < cfg.specs; i++) {
                if (sorted[i] && !seenSpecialists.has(sorted[i].name)) {
                    specialistsPool.push(sorted[i]);
                    seenSpecialists.add(sorted[i].name);
                }
            }
        });

        // 2. Randomized LP Trials
        const trials: { pool: Food[], z: number }[] = [];
        const subsetSize = Math.min(cfg.subset, specialistsPool.length); 
        
        parentPort?.postMessage({ type: 'progress', gen: 5, accuracy: 0, telemetry: { trialInfo: `Testing ${cfg.trials} Combinations...` } });

        const trialInterval = Math.max(1, Math.floor(cfg.trials / 20));
        for (let i = 0; i < cfg.trials; i++) {
            const shuffled = [...specialistsPool].sort(() => 0.5 - Math.random());
            const randomSubset = shuffled.slice(0, subsetSize);
            const trialPool = Array.from(new Set([...mustHaveFoods, ...randomSubset]));
            
            const res = await solveGLPK(trialPool, false, 5);
            if (res.result.status === 5 || res.result.status === 2) {
                // IMPORTANT: trials are ranked by 'z' which prioritizes macro feasibility first,
                // but then uses nutrient coverage as the differentiator.
                trials.push({ pool: trialPool, z: res.result.z });
            }

            if (i % trialInterval === 0) {
                parentPort?.postMessage({ type: 'progress', gen: 5 + (i/cfg.trials * 40), accuracy: 0, telemetry: { trialInfo: `Analysing Combos ${i}/${cfg.trials}...` } });
            }
        }

        // 3. Take Top Finalists for full MILP Refinement
        trials.sort((a, b) => b.z - a.z);
        const finalists = trials.slice(0, cfg.refinements);

        // 4. Run MILP Refinements
        const results: any[] = [];
        for (let i = 0; i < finalists.length; i++) {
            parentPort?.postMessage({ type: 'progress', gen: 45 + (i/finalists.length * 50), accuracy: 0, telemetry: { trialInfo: `Optimizing Top Combo ${i+1}/${finalists.length}...` } });
            const res = await solveGLPK(finalists[i].pool, true, cfg.milpLimit);
            if (res.result.vars) {
                const genome: Record<string, number> = {};
                finalists[i].pool.forEach((f, idx) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                results.push(evaluateDiet(genome));
            }
        }

        // 5. Final Best Pick
        results.sort((a, b) => b.score - a.score);
        const bestEval = results[0] || evaluateDiet({});

        clearTimeout(totalTimeout);
        parentPort?.postMessage({ 
            type: 'result', 
            result: {
                genome: bestEval.genome,
                targetCalories,
                actualCalories: Math.round(bestEval.totals.energy),
                accuracy: bestEval.accuracy,
                macros: { protein: Math.round(bestEval.totals.protein), carbs: Math.round(bestEval.totals.carbs), fat: Math.round(bestEval.totals.fat) }
            }
        });
    } catch (err: any) {
        log(`FATAL ERROR IN RUN: ${err.message}\n${err.stack}`);
        clearTimeout(totalTimeout);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
