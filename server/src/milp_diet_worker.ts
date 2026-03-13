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

const modelType = details.algoModel || 'beast';
log(`Worker starting in ${modelType.toUpperCase()} mode...`);

const foodMap = new Map<string, Food>();
FOOD_DATABASE.forEach((f: Food) => foodMap.set(f.name, f));

log("Awaiting GLPK module initialization...");
const GLPK_PROMISE = (glpkModule as any)();

/**
 * Granular Saturation Score (Capped at 100% per nutrient)
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
 * FINAL QUALITY CHECK:
 * Prevents "Water Only" or broken diets from ever being shown.
 */
function checkDietQuality(result: any): { valid: boolean, reason?: string } {
    if (!result || !result.genome || Object.keys(result.genome).length <= 1) {
        return { valid: false, reason: "Diet contains too few food items." };
    }

    const totals = result.totals;
    const cals = totals.energy;
    
    // 1. Calorie Check: Must be within reasonable range of target
    if (cals < targetCalories * 0.8 || cals > (targetCalories + 200)) {
        return { valid: false, reason: `Calories (${Math.round(cals)}) are too far from target (${targetCalories}).` };
    }

    // 2. Macro Check: Ensure no massive drifts beyond elastic window
    const pDiff = Math.abs(totals.protein - proteinTarget);
    const fDiff = Math.abs(totals.fat - fatTarget);
    const cDiff = Math.abs(totals.carbs - carbTarget);
    
    if (pDiff > 30 || fDiff > 30 || cDiff > 30) {
        return { valid: false, reason: `Macro drift too large (P:${Math.round(pDiff)}g, F:${Math.round(fDiff)}g, C:${Math.round(cDiff)}g).` };
    }

    // 3. Selection Check: Verify no unselected foods
    const allowedNames = new Set([...(details.likedFoods || []), ...(details.mustHaveFoods || []).map((m: any) => m.name)]);
    for (const name of Object.keys(result.genome)) {
        if (!allowedNames.has(name) && name !== "Mineral Water") {
            return { valid: false, reason: `Diet contains unselected food: ${name}` };
        }
    }

    // 4. Nutrient Max Check: Strictly enforce upper limits
    for (const k of essentialKeys) {
        if (nutrientConfig[k].max && totals[k] > (nutrientConfig[k].max + 0.1)) {
            return { valid: false, reason: `${nutrientNames[k] || k} (${Math.round(totals[k])}) exceeds max limit (${nutrientConfig[k].max}).` };
        }
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

    const calWeight = weightMode === 'strict' ? 1000000000000 : 10000000;
    const nutrientWeight = 100000; 

    vars.push({ name: 'cal_def', lb: 0, ub: 10000, type: glp.GLP_DB });
    objectiveVars.push({ name: 'cal_def', coef: -calWeight });

    ['protein', 'fat', 'carbs'].forEach(m => {
        const isStrict = (details.macros as any)[m]?.strict ?? true;
        if (isStrict) {
            if (weightMode === 'scout') {
                vars.push({ name: `${m}_def`, lb: 0, ub: 1000, type: glp.GLP_DB });
                vars.push({ name: `${m}_ex`, lb: 0, ub: 1000, type: glp.GLP_DB });
                objectiveVars.push({ name: `${m}_def`, coef: -1000000000 });
                objectiveVars.push({ name: `${m}_ex`, coef: -1000000000 });
            }
        } else {
            vars.push({ name: `${m}_def`, lb: 0, ub: 20, type: glp.GLP_DB });
            vars.push({ name: `${m}_ex`, lb: 0, ub: 20, type: glp.GLP_DB });
            objectiveVars.push({ name: `${m}_def`, coef: 0 });
            objectiveVars.push({ name: `${m}_ex`, coef: 0 });
        }
    });

    if (weightMode === 'scout') {
        essentialKeys.forEach((k: string) => {
            if (nutrientConfig[k].max) {
                vars.push({ name: `max_slack_${k}`, lb: 0, ub: 1000000, type: glp.GLP_DB });
                objectiveVars.push({ name: `max_slack_${k}`, coef: -1000000000 });
            }
        });
    }

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
        let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : 
                     (customMax !== undefined ? (customMax / 100) : (f.maxAmount / 100));
        
        if (maxVal < minVal) maxVal = minVal;

        vars.push({ name: `f_${i}`, lb: (!isMILP && mustHave) ? minVal : 0, ub: maxVal, type: glp.GLP_DB });
        objectiveVars.push({ name: `f_${i}`, coef: f.calories * 0.001 }); 

        if (isMILP) {
            vars.push({ name: `u_${i}`, lb: 0, ub: 1, type: glp.GLP_DB });
            binaries.push(`u_${i}`);
            constraints.push({ name: `min_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -minVal }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
            constraints.push({ name: `max_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -maxVal }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
            if (mustHave) constraints.push({ name: `force_${i}`, vars: [{ name: `u_${i}`, coef: 1 }], bnds: { type: glp.GLP_FX, lb: 1, ub: 1 } });
        }
    });

    constraints.push({ name: 'cal_min', vars: [...foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })), { name: 'cal_def', coef: 1 }], bnds: { type: glp.GLP_LO, lb: targetCalories, ub: 0 } });
    constraints.push({ name: 'cal_max', vars: foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })), bnds: { type: glp.GLP_UP, lb: 0, ub: targetCalories + 50 } });

    const macroTargets = [{ name: 'protein', val: proteinTarget }, { name: 'fat', val: fatTarget }, { name: 'carbs', val: carbTarget }];
    macroTargets.forEach(m => {
        const isStrict = (details.macros as any)[m.name]?.strict ?? true;
        const constraintVars = foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] }));
        if (isStrict && weightMode === 'strict') {
            constraints.push({ name: `macro_${m.name}`, vars: constraintVars, bnds: { type: glp.GLP_DB, lb: m.val - 2, ub: m.val + 2 } });
        } else {
            constraints.push({ name: `macro_${m.name}`, vars: [...constraintVars, { name: `${m.name}_def`, coef: 1 }, { name: `${m.name}_ex`, coef: -1 }], bnds: { type: glp.GLP_FX, lb: m.val, ub: m.val } });
        }
    });

    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        const foodCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) / (config.target || 1) }));
        constraints.push({ name: `link_cov_${k}`, vars: [...foodCoeffs, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
        constraints.push({ name: `link_min_${k}`, vars: [{ name: 'min_coverage', coef: 1 }, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
        if (config.max) {
            const varsList = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) }));
            if (weightMode === 'scout') varsList.push({ name: `max_slack_${k}`, coef: -1 });
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

        // --- THE ELITE LEADERBOARD ---
        let eliteLeaderboard: any[] = [];

        const updateLeaderboard = (evalResult: any) => {
            eliteLeaderboard.push(evalResult);
            eliteLeaderboard.sort((a, b) => b.score - a.score);
            eliteLeaderboard = eliteLeaderboard.slice(0, 10);
        };

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
                const genome: Record<string, number> = {};
                trialPool.forEach((f: Food, idx: number) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                updateLeaderboard({ ...evaluateDiet(genome), pool: trialPool });
            }
            if (i % trialInterval === 0) parentPort?.postMessage({ type: 'progress', gen: 5 + (i/cfg.trials * 40), accuracy: 0, telemetry: { trialInfo: `Simulating Combos ${i}/${cfg.trials}...` } });
        }

        // --- MILP REFINEMENTS ---
        const initialElite = [...eliteLeaderboard];
        for (let i = 0; i < initialElite.length; i++) {
            parentPort?.postMessage({ type: 'progress', gen: 45 + (i/initialElite.length * 50), accuracy: eliteLeaderboard[0]?.accuracy || 0, telemetry: { trialInfo: `Refining Elite Pool ${i+1}/${initialElite.length}...` } });
            const res = await solveGLPK(initialElite[i].pool, true, 'strict', cfg.milpLimit);
            if (res.result.vars) {
                const genome: Record<string, number> = {};
                initialElite[i].pool.forEach((f: Food, idx: number) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                updateLeaderboard(evaluateDiet(genome));
            }
        }

        // --- FINAL SELECTION & QUALITY GATE ---
        let bestValidDiet = null;
        for (const candidate of eliteLeaderboard) {
            const quality = checkDietQuality(candidate);
            if (quality.valid) {
                bestValidDiet = candidate;
                break;
            } else {
                log(`Rejected candidate: ${quality.reason}`);
            }
        }

        if (bestValidDiet) {
            log(`Final Choice Accuracy: ${bestValidDiet.accuracy}%`);
            clearTimeout(totalTimeout);
            parentPort?.postMessage({ type: 'result', result: { genome: bestValidDiet.genome, targetCalories, actualCalories: Math.round(bestValidDiet.totals.energy), accuracy: bestValidDiet.accuracy, macros: { protein: Math.round(bestValidDiet.totals.protein), carbs: Math.round(bestValidDiet.totals.carbs), fat: Math.round(bestValidDiet.totals.fat) } } });
        } else {
            log("CRITICAL: No valid diets passed the quality gate.");
            parentPort?.postMessage({ type: 'result', result: null });
        }

    } catch (err: any) {
        log(`FATAL ERROR: ${err.message}`);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
