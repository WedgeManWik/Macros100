import { parentPort, workerData } from 'worker_threads';
// @ts-ignore
import glpkModule from 'glpk.js/node';
import { Food } from './types.js';

function log(msg: string) {
    console.log(`[MILP Worker] ${msg}`);
    parentPort?.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: msg } });
}

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const foodMap = new Map<string, Food>();
FOOD_DATABASE.forEach((f: Food) => foodMap.set(f.name, f));

log("Awaiting GLPK module initialization...");
const GLPK_PROMISE = (glpkModule as any)();

function calculateNutrientScore(totals: any) {
    let score = 0;
    essentialKeys.forEach((k: string) => {
        const target = nutrientConfig[k].target || 1;
        const pct = (totals[k] || 0) / target;
        score += Math.min(1.0, pct);
    });
    return score;
}

function checkDietQuality(result: any, strictness: 'high' | 'low' = 'high'): { valid: boolean, reason?: string } {
    if (!result || !result.genome || Object.keys(result.genome).length <= 1) {
        return { valid: false, reason: "Too few foods." };
    }
    const totals = result.totals;
    const cals = totals.energy;
    
    // 1. Calorie Check
    if (cals < targetCalories * 0.7 || cals > (targetCalories + 300)) {
        return { valid: false, reason: `Cals (${Math.round(cals)}) way off.` };
    }

    // 2. Macro Check (Adaptive strictness)
    const limit = strictness === 'high' ? 15 : 40; 
    const pDiff = Math.abs(totals.protein - proteinTarget);
    const fDiff = Math.abs(totals.fat - fatTarget);
    const cDiff = Math.abs(totals.carbs - carbTarget);
    if (pDiff > limit || fDiff > limit || cDiff > limit) {
        return { valid: false, reason: `Macro drift too large (P:${Math.round(pDiff)}g, F:${Math.round(fDiff)}g, C:${Math.round(cDiff)}g).` };
    }

    // 3. Nutrient Max Check: Strictly enforce upper limits
    for (const k of essentialKeys) {
        if (nutrientConfig[k].max && totals[k] > (nutrientConfig[k].max + 0.1)) {
            return { valid: false, reason: `${nutrientNames[k] || k} exceeds max limit.` };
        }
    }

    // 4. Min Amount Check
    for (const [name, amt] of Object.entries(result.genome)) {
        if (amt as number <= 0) continue;
        const f = foodMap.get(name);
        if (!f) continue;
        const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
        const minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0));
        if ((amt as number) < minVal - 1.0) return { valid: false, reason: `${name} (${amt}g) below min (${minVal}g).` };
    }

    return { valid: true };
}

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
        if (f.nutrients) for (const n in f.nutrients) if (totals[n] !== undefined) totals[n] += amt * (f.nutrients[n] || 0);
    });
    return totals;
}

async function solveGLPK(foods: Food[], isMILP: boolean, weightMode: 'scout' | 'strict', timeLimit: number) {
    const glp = await GLPK_PROMISE;
    const vars: any[] = [];
    const constraints: any[] = [];
    const binaries: string[] = [];
    const objectiveVars: any[] = [];

    const calWeight = 1000000000000;
    const nutrientWeight = 100000; 

    vars.push({ name: 'cal_def', lb: 0, ub: 10000, type: glp.GLP_DB });
    objectiveVars.push({ name: 'cal_def', coef: -calWeight });

    ['protein', 'fat', 'carbs'].forEach(m => {
        const isStrict = (details.macros as any)[m]?.strict ?? true;
        // In BEAST mode we still need some slack or MILP fails immediately.
        // Penalty: Strict=10^9, Non-Strict=10^4
        const penalty = isStrict ? 1000000000 : 10000;
        vars.push({ name: `${m}_def`, lb: 0, ub: isStrict ? 5 : 50, type: glp.GLP_DB });
        vars.push({ name: `${m}_ex`, lb: 0, ub: isStrict ? 5 : 50, type: glp.GLP_DB });
        objectiveVars.push({ name: `${m}_def`, coef: -penalty });
        objectiveVars.push({ name: `${m}_ex`, coef: -penalty });
    });

    essentialKeys.forEach((k: string) => {
        if (nutrientConfig[k].max) {
            vars.push({ name: `max_slack_${k}`, lb: 0, ub: 1000000, type: glp.GLP_DB });
            objectiveVars.push({ name: `max_slack_${k}`, coef: -1000000000 });
        }
    });

    essentialKeys.forEach((k: string) => {
        vars.push({ name: `cov_${k}`, lb: 0, ub: 1.0, type: glp.GLP_DB });
        objectiveVars.push({ name: `cov_${k}`, coef: nutrientWeight }); 
    });

    vars.push({ name: 'min_coverage', lb: 0, ub: 1.0, type: glp.GLP_DB });
    objectiveVars.push({ name: 'min_coverage', coef: nutrientWeight * 10 }); 

    foods.forEach((f, i) => {
        const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
        const customMax = details.customMaxAmounts?.[f.name];
        let minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
        let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : (customMax !== undefined ? (customMax / 100) : (f.maxAmount / 100));
        vars.push({ name: `f_${i}`, lb: (!isMILP && mustHave) ? minVal : 0, ub: Math.max(minVal, maxVal), type: glp.GLP_DB });
        objectiveVars.push({ name: `f_${i}`, coef: f.calories * 0.001 }); 
        if (isMILP) {
            vars.push({ name: `u_${i}`, lb: 0, ub: 1, type: glp.GLP_DB });
            binaries.push(`u_${i}`);
            constraints.push({ name: `min_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -minVal }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
            constraints.push({ name: `max_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -maxVal }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
            if (mustHave) constraints.push({ name: `force_${i}`, vars: [{ name: `u_${i}`, coef: 1 }], bnds: { type: glp.GLP_FX, lb: 1, ub: 1 } });
        }
    });
// --- 4. CONSTRAINTS ---

// Calories: Standard [target, target + 50] or Strict [target - 20, target + 20]
const isStrictCal = details.strictCalories ?? false;
const calLB = isStrictCal ? (targetCalories - 20) : targetCalories;
const calUB = isStrictCal ? (targetCalories + 20) : (targetCalories + 50);

constraints.push({ 
    name: 'cal_range', 
    vars: [...foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })), { name: 'cal_def', coef: 1 }], 
    bnds: { type: glp.GLP_DB, lb: calLB, ub: calUB } 
});


    const macroTargets = [{ name: 'protein', val: proteinTarget }, { name: 'fat', val: fatTarget }, { name: 'carbs', val: carbTarget }];
    macroTargets.forEach(m => {
        const constraintVars = foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] }));
        constraints.push({ name: `macro_${m.name}`, vars: [...constraintVars, { name: `${m.name}_def`, coef: 1 }, { name: `${m.name}_ex`, coef: -1 }], bnds: { type: glp.GLP_FX, lb: m.val, ub: m.val } });
    });

    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        const foodCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) / (config.target || 1) }));
        constraints.push({ name: `lk_cov_${k}`, vars: [...foodCoeffs, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
        constraints.push({ name: `lk_min_${k}`, vars: [{ name: 'min_coverage', coef: 1 }, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
        if (config.max) {
            const varsList = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) }));
            varsList.push({ name: `max_slack_${k}`, coef: -1 });
            constraints.push({ name: `max_${k}`, vars: varsList, bnds: { type: glp.GLP_UP, lb: 0, ub: config.max } });
        }
    });

    return await glp.solve({ name: 'DietPlanner', objective: { direction: glp.GLP_MAX, name: 'score', vars: objectiveVars }, subjectTo: constraints, bounds: vars, binaries: binaries, options: { presol: true, tmlim: timeLimit } });
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
    let totalPct = 0;
    essentialKeys.forEach((k: string) => { totalPct += Math.min(1.0, (totals[k] / (nutrientConfig[k].target || 1))); });
    const accuracy = Math.round((totalPct / essentialKeys.length) * 1000) / 10;
    return { accuracy, totals, genome, score: totalPct };
}

async function run() {
    const modelType = details.algoModel || 'beast';
    const configs: Record<string, any> = {
        beast: { specs: 5, trials: 1000, subset: 25, refinements: 10, milpLimit: 15, timeout: 120000 },
        titan: { specs: 10, trials: 5000, subset: 25, refinements: 20, milpLimit: 20, timeout: 240000 },
        olympian: { specs: 15, trials: 15000, subset: 25, refinements: 30, milpLimit: 30, timeout: 480000 },
        god: { specs: 20, trials: 40000, subset: 25, refinements: 50, milpLimit: 40, timeout: 900000 }
    };
    let cfg = configs[modelType] || configs.beast;

    const totalTimeout = setTimeout(() => {
        log("Worker Global Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, cfg.timeout);

    try {
        const likedSet = new Set(details.likedFoods || []);
        const mustHaveSet = new Set((details.mustHaveFoods || []).map((m: any) => m.name));
        const likedPool = FOOD_DATABASE.filter((f: Food) => likedSet.has(f.name) || mustHaveSet.has(f.name));

        const specialistMap = new Map<string, Food[]>();
        essentialKeys.forEach((k: string) => {
            const sorted = [...likedPool].sort((a, b) => {
                const getVal = (f: Food) => (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
                return (getVal(b) / (b.calories || 1)) - (getVal(a) / (a.calories || 1));
            });
            specialistMap.set(k, sorted.slice(0, cfg.specs));
        });

        let trialLeaderboard: { pool: Food[], score: number }[] = [];
        const trialInterval = Math.max(1, Math.floor(cfg.trials/20));
        for (let i = 0; i < cfg.trials; i++) {
            const randomSpecs = new Set<string>();
            essentialKeys.forEach((k: string) => {
                const options = specialistMap.get(k)!;
                if (options.length > 0) {
                    const idx = Math.random() < 0.8 ? Math.floor(Math.random() * Math.min(5, options.length)) : Math.floor(Math.random() * options.length);
                    randomSpecs.add(options[idx].name);
                }
            });
            const trialNames = new Set([...Array.from(randomSpecs), ...mustHaveSet]);
            const shuffledLiked = [...likedPool].sort(() => 0.5 - Math.random());
            for (let j = 0; j < shuffledLiked.length && trialNames.size < cfg.subset; j++) trialNames.add(shuffledLiked[j].name);
            const trialPool = FOOD_DATABASE.filter((f: Food) => trialNames.has(f.name));
            const res = await solveGLPK(trialPool, false, 'scout', 5);
            if (res.result.status === 5 || res.result.status === 2) {
                const totals = getTotalsFromVars(res.result.vars, trialPool);
                trialLeaderboard.push({ pool: trialPool, score: calculateNutrientScore(totals) });
                trialLeaderboard.sort((a, b) => b.score - a.score);
                trialLeaderboard = trialLeaderboard.slice(0, cfg.refinements);
            }
            if (i % trialInterval === 0) parentPort?.postMessage({ type: 'progress', gen: 5 + (i/cfg.trials * 40), accuracy: 0, telemetry: { trialInfo: `Searching Combos ${i}/${cfg.trials}...` } });
        }

        let finalCandidates: any[] = [];
        for (let i = 0; i < trialLeaderboard.length; i++) {
            parentPort?.postMessage({ type: 'progress', gen: 45 + (i/trialLeaderboard.length * 50), accuracy: finalCandidates[0]?.accuracy || 0, telemetry: { trialInfo: `Refining Combo ${i+1}/${trialLeaderboard.length}...` } });
            const res = await solveGLPK(trialLeaderboard[i].pool, true, 'strict', cfg.milpLimit);
            if (res.result.vars) {
                const genome: Record<string, number> = {};
                trialLeaderboard[i].pool.forEach((f: Food, idx: number) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                const evalResult = evaluateDiet(genome);
                const quality = checkDietQuality(evalResult, 'high');
                if (quality.valid) {
                    finalCandidates.push(evalResult);
                    finalCandidates.sort((a, b) => b.score - a.score);
                } else {
                    log(`Rejected: ${quality.reason}`);
                }
            }
        }

        if (finalCandidates.length === 0) {
            log("No high-quality diets. Retrying with lower strictness...");
            for (let i = 0; i < trialLeaderboard.length; i++) {
                const res = await solveGLPK(trialLeaderboard[i].pool, true, 'strict', cfg.milpLimit);
                if (res.result.vars) {
                    const genome: Record<string, number> = {};
                    trialLeaderboard[i].pool.forEach((f: Food, idx: number) => {
                        const val = res.result.vars[`f_${idx}`] || 0;
                        if (val > 0.001) genome[f.name] = Math.round(val * 100);
                    });
                    const evalResult = evaluateDiet(genome);
                    if (checkDietQuality(evalResult, 'low').valid) {
                        finalCandidates.push(evalResult);
                    }
                }
            }
            finalCandidates.sort((a, b) => b.score - a.score);
        }

        if (finalCandidates.length > 0) {
            const best = finalCandidates[0];
            clearTimeout(totalTimeout);
            parentPort?.postMessage({ type: 'result', result: { genome: best.genome, targetCalories, actualCalories: Math.round(best.totals.energy), accuracy: best.accuracy, macros: { protein: Math.round(best.totals.protein), carbs: Math.round(best.totals.carbs), fat: Math.round(best.totals.fat) } } });
        } else {
            log("CRITICAL: Failed to find any valid diet.");
            parentPort?.postMessage({ type: 'result', result: null });
        }
    } catch (err: any) {
        log(`FATAL ERROR: ${err.message}`);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
