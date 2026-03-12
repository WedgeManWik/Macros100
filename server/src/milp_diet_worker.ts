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
log(`Worker starting in ${modelType.toUpperCase()} mode (STRICT MIN-AMOUNT)...`);

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
 * Checks if a genome respects ALL food boundaries (min/max)
 * Crucial for preventing LP "crumbs" from entering results.
 */
function isValidGenome(genome: Record<string, number>) {
    for (const [name, amt] of Object.entries(genome)) {
        if (amt <= 0) continue;
        const f = foodMap.get(name);
        if (!f) continue;

        const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
        const customMax = details.customMaxAmounts?.[f.name];
        
        const minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0));
        const maxVal = (mustHave && mustHave.max !== undefined) ? mustHave.max : 
                     (customMax !== undefined ? customMax : (f.maxAmount || 10000));
        
        // Use a small epsilon for float comparison (0.1g)
        if (amt < minVal - 0.1 || amt > maxVal + 0.1) return false;
    }
    return true;
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
        if (f.nutrients) {
            for (const n in f.nutrients) {
                if (totals[n] !== undefined) totals[n] += amt * (f.nutrients[n] || 0);
            }
        }
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
    const macroWeight = weightMode === 'strict' ? 1000000000 : 1000000;
    const nutrientWeight = 100000; 

    vars.push({ name: 'cal_def', lb: 0, ub: 10000, type: glp.GLP_DB });
    objectiveVars.push({ name: 'cal_def', coef: -calWeight });

    ['protein', 'fat', 'carbs'].forEach(m => {
        vars.push({ name: `${m}_def`, lb: 0, ub: 1000, type: glp.GLP_DB });
        vars.push({ name: `${m}_ex`, lb: 0, ub: 1000, type: glp.GLP_DB });
        objectiveVars.push({ name: `${m}_def`, coef: -macroWeight });
        objectiveVars.push({ name: `${m}_ex`, coef: -macroWeight });
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
        constraints.push({ name: `macro_${m.name}`, vars: [...foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] })), { name: `${m.name}_def`, coef: 1 }, { name: `${m.name}_ex`, coef: -1 }], bnds: { type: glp.GLP_FX, lb: m.val, ub: m.val } });
    });

    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        const foodCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) / (config.target || 1) }));
        constraints.push({ name: `link_cov_${k}`, vars: [...foodCoeffs, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
        constraints.push({ name: `link_min_${k}`, vars: [{ name: 'min_coverage', coef: 1 }, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
        if (config.max) {
            constraints.push({ name: `max_${k}`, vars: [...foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) })), { name: `max_slack_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: config.max } });
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
    if (details.benchConfig) {
        cfg = { specs: details.benchConfig.specs, trials: details.benchConfig.trials, subset: details.benchConfig.subset, refinements: details.benchConfig.refinements, milpLimit: 15, timeout: 300000 };
    }

    const totalTimeout = setTimeout(() => {
        log("Worker Global Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, cfg.timeout);

    try {
        const likedPool = FOOD_DATABASE.filter((f: Food) => {
            const liked = details.likedFoods || [];
            if (liked.length === 0) return true;
            const nameLower = f.name.toLowerCase();
            return liked.some((l: string) => nameLower.includes(l.toLowerCase()));
        });
        const mustHavePool = FOOD_DATABASE.filter((f: Food) => (details.mustHaveFoods || []).some((m: any) => m.name === f.name));

        const specialistMap = new Map<string, Food[]>();
        essentialKeys.forEach((k: string) => {
            const sorted = [...likedPool].sort((a, b) => {
                const getVal = (f: Food) => (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
                return (getVal(b) / (b.calories || 1)) - (getVal(a) / (a.calories || 1));
            });
            specialistMap.set(k, sorted.slice(0, cfg.specs));
        });

        const trials: { pool: Food[], score: number, genome: Record<string, number>, totals: any }[] = [];
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
            const trialNames = new Set([...Array.from(randomSpecs), ...mustHavePool.map((f: Food) => f.name)]);
            const shuffledLiked = [...likedPool].sort(() => 0.5 - Math.random());
            for (let j = 0; j < shuffledLiked.length && trialNames.size < cfg.subset; j++) trialNames.add(shuffledLiked[j].name);
            const trialPool = FOOD_DATABASE.filter((f: Food) => trialNames.has(f.name));
            const res = await solveGLPK(trialPool, false, 'scout', 5);
            if (res.result.status === 5 || res.result.status === 2) {
                const totals = getTotalsFromVars(res.result.vars, trialPool);
                const genome: Record<string, number> = {};
                trialPool.forEach((f: Food, idx: number) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                trials.push({ pool: trialPool, score: calculateNutrientScore(totals), genome, totals });
            }
            if (i % trialInterval === 0) parentPort?.postMessage({ type: 'progress', gen: 5 + (i/cfg.trials * 40), accuracy: 0, telemetry: { trialInfo: `Simulating Combos ${i}/${cfg.trials}...` } });
        }

        trials.sort((a, b) => b.score - a.score);
        const finalists = trials.slice(0, cfg.refinements);
        
        let bestOverall: any = null;
        // CRITICAL FIX: Only seed the leaderboard if the LP result is VALID (respects min amounts)
        // Since LP almost NEVER respects min amounts, we usually skip this and wait for MILP.
        if (finalists.length > 0 && isValidGenome(finalists[0].genome)) {
            bestOverall = { accuracy: Math.round((finalists[0].score / essentialKeys.length) * 1000) / 10, totals: finalists[0].totals, genome: finalists[0].genome, score: finalists[0].score };
        }

        for (let i = 0; i < finalists.length; i++) {
            parentPort?.postMessage({ type: 'progress', gen: 45 + (i/finalists.length * 50), accuracy: bestOverall?.accuracy || 0, telemetry: { trialInfo: `Refining Top Winner ${i+1}/${finalists.length}...` } });
            const res = await solveGLPK(finalists[i].pool, true, 'strict', cfg.milpLimit);
            if (res.result.vars) {
                const genome: Record<string, number> = {};
                finalists[i].pool.forEach((f, idx) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                if (isValidGenome(genome)) {
                    const evalResult = evaluateDiet(genome);
                    if (!bestOverall || evalResult.score > bestOverall.score) bestOverall = evalResult;
                }
            }
        }

        const finalEval = bestOverall || evaluateDiet({});
        clearTimeout(totalTimeout);
        parentPort?.postMessage({ type: 'result', result: { genome: finalEval.genome, targetCalories, actualCalories: Math.round(finalEval.totals.energy), accuracy: finalEval.accuracy, macros: { protein: Math.round(finalEval.totals.protein), carbs: Math.round(finalEval.totals.carbs), fat: Math.round(finalEval.totals.fat) } } });
    } catch (err: any) {
        log(`FATAL ERROR: ${err.message}`);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
