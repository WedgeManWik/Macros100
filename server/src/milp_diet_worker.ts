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

function checkDietQuality(result: any, pass: 'strict' | 'relaxed' = 'strict'): { valid: boolean, reason?: string } {
    if (!result || !result.genome || Object.keys(result.genome).length <= 1) {
        return { valid: false, reason: "Too few foods." };
    }
    const totals = result.totals;
    const cals = totals.energy;
    
    // CALORIES: Hard Priority #1
    const calLB = details.strictCalories ? (targetCalories - 20) : targetCalories;
    const calUB = details.strictCalories ? (targetCalories + 20) : (targetCalories + 55);
    if (cals < calLB - 1 || cals > calUB + 1) return { valid: false, reason: `Calories (${Math.round(cals)}) outside budget.` };

    // MACROS: Hard Priority #2
    const pDiff = Math.abs(totals.protein - proteinTarget);
    const fDiff = Math.abs(totals.fat - fatTarget);
    const cDiff = Math.abs(totals.carbs - carbTarget);
    
    const pLimit = details.macros.protein.strict ? 2.5 : 6;
    const fLimit = details.macros.fat.strict ? 2.5 : 6;
    const cLimit = details.macros.carbs.strict ? 2.5 : 6;

    if (pDiff > pLimit || fDiff > fLimit || cDiff > cLimit) {
        return { valid: false, reason: `Macros missed targets.` };
    }

    // SAFETY: Hard Priority #3
    for (const k of essentialKeys) {
        if (nutrientConfig[k].max && totals[k] > (nutrientConfig[k].max + 0.5)) {
            return { valid: false, reason: `${nutrientNames[k] || k} exceeded.` };
        }
    }

    return { valid: true };
}

function getTotalsFromVars(vars: any, pool: Food[]) {
    const totals: any = { energy: 0, protein: 0, carbs: 0, fat: 0 };
    Object.keys(nutrientConfig).forEach(k => totals[k] = 0);
    if (!vars) return totals;
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
    try {
        const glp = await GLPK_PROMISE;
        const vars: any[] = [];
        const constraints: any[] = [];
        const binaries: string[] = [];
        const objectiveVars: any[] = [];

        const macroTargets = [
            { name: 'protein', val: proteinTarget, strict: details.macros.protein.strict },
            { name: 'fat', val: fatTarget, strict: details.macros.fat.strict },
            { name: 'carbs', val: carbTarget, strict: details.macros.carbs.strict }
        ];
        
        // 1. NUTRIENT SCORE (Objective)
        essentialKeys.forEach((k: string) => {
            vars.push({ name: `cov_${k}`, lb: 0, ub: 1.0, type: glp.GLP_DB });
            objectiveVars.push({ name: `cov_${k}`, coef: 1000 }); 
        });
        vars.push({ name: 'min_cov', lb: 0, ub: 1.0, type: glp.GLP_DB });
        objectiveVars.push({ name: 'min_cov', coef: 5000 });

        // 2. FOODS
        foods.forEach((f, i) => {
            const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
            const customMax = details.customMaxAmounts?.[f.name];
            let minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
            let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : (customMax !== undefined ? (customMax / 100) : (f.maxAmount / 100));
            vars.push({ name: `f_${i}`, lb: (!isMILP && mustHave) ? minVal : 0, ub: Math.max(minVal, maxVal), type: glp.GLP_DB });
            objectiveVars.push({ name: `f_${i}`, coef: -0.0001 }); // Density bias

            if (isMILP) {
                vars.push({ name: `u_${i}`, lb: 0, ub: 1, type: glp.GLP_DB });
                binaries.push(`u_${i}`);
                constraints.push({ name: `min_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -minVal }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
                constraints.push({ name: `max_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -maxVal }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
                if (mustHave) constraints.push({ name: `force_${i}`, vars: [{ name: `u_${i}`, coef: 1 }], bnds: { type: glp.GLP_FX, lb: 1, ub: 1 } });
            }
        });

        // 3. HARD CONSTRAINTS (Locking Priorities)
        const calLB = details.strictCalories ? (targetCalories - 20) : targetCalories;
        const calUB = details.strictCalories ? (targetCalories + 20) : (targetCalories + 50);
        constraints.push({ 
            name: 'c_cal', 
            vars: foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })), 
            bnds: { type: glp.GLP_DB, lb: calLB, ub: calUB } 
        });

        macroTargets.forEach(m => {
            const limit = m.strict ? 2.0 : 5.5;
            constraints.push({ 
                name: `macro_${m.name}`, 
                vars: foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] })), 
                bnds: { type: glp.GLP_DB, lb: m.val - limit, ub: m.val + limit } 
            });
        });

        essentialKeys.forEach((k: string) => {
            const config = nutrientConfig[k];
            const foodCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) / (config.target || 1) }));
            constraints.push({ name: `lk_cov_${k}`, vars: [...foodCoeffs, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
            constraints.push({ name: `lk_min_${k}`, vars: [{ name: 'min_cov', coef: 1 }, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
            if (config.max) {
                constraints.push({ 
                    name: `max_${k}`, 
                    vars: foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) })), 
                    bnds: { type: glp.GLP_UP, lb: 0, ub: config.max } 
                });
            }
        });

        return await glp.solve({ name: 'DietPlanner', objective: { direction: glp.GLP_MAX, name: 'score', vars: objectiveVars }, subjectTo: constraints, bounds: vars, binaries: binaries, options: { presol: true, tmlim: timeLimit } });
    } catch (err: any) {
        return { result: { status: 0, error: err.message } };
    }
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

async function diagnoseFailure(allPool: Food[]) {
    try {
        const glp = await GLPK_PROMISE;
        const vars: any[] = [];
        const constraints: any[] = [];
        const objectiveVars: any[] = [];

        vars.push({ name: 'diag_cal_def', lb: 0, ub: 5000, type: glp.GLP_DB });
        vars.push({ name: 'diag_cal_ex', lb: 0, ub: 5000, type: glp.GLP_DB });
        objectiveVars.push({ name: 'diag_cal_def', coef: -1000000 });
        objectiveVars.push({ name: 'diag_cal_ex', coef: -1000000 });

        ['protein', 'fat', 'carbs'].forEach(m => {
            vars.push({ name: `diag_${m}_def`, lb: 0, ub: 500, type: glp.GLP_DB });
            vars.push({ name: `diag_${m}_ex`, lb: 0, ub: 500, type: glp.GLP_DB });
            objectiveVars.push({ name: `diag_${m}_def`, coef: -1000000 });
            objectiveVars.push({ name: `diag_${m}_ex`, coef: -1000000 });
        });

        essentialKeys.forEach((k: string) => {
            if (nutrientConfig[k].max) {
                vars.push({ name: `diag_max_${k}`, lb: 0, ub: 1000000, type: glp.GLP_DB });
                objectiveVars.push({ name: `diag_max_${k}`, coef: -1000000000 });
            }
        });

        allPool.forEach((f, i) => {
            const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
            const minVal = (mustHave ? (mustHave.min || 0) : 0) / 100;
            vars.push({ name: `f_${i}`, lb: minVal, ub: 50, type: glp.GLP_DB });
            objectiveVars.push({ name: `f_${i}`, coef: 1 }); 
        });

        constraints.push({ name: 'c_cal', vars: [...allPool.map((f, i) => ({ name: `f_${i}`, coef: f.calories })), { name: 'diag_cal_def', coef: 1 }, { name: 'diag_cal_ex', coef: -1 }], bnds: { type: glp.GLP_FX, lb: targetCalories, ub: targetCalories } });
        constraints.push({ name: 'c_p', vars: [...allPool.map((f, i) => ({ name: `f_${i}`, coef: f.protein })), { name: 'diag_protein_def', coef: 1 }, { name: 'diag_protein_ex', coef: -1 }], bnds: { type: glp.GLP_FX, lb: proteinTarget, ub: proteinTarget } });
        constraints.push({ name: 'c_f', vars: [...allPool.map((f, i) => ({ name: `f_${i}`, coef: f.fat })), { name: 'diag_fat_def', coef: 1 }, { name: 'diag_fat_ex', coef: -1 }], bnds: { type: glp.GLP_FX, lb: fatTarget, ub: fatTarget } });
        constraints.push({ name: 'c_c', vars: [...allPool.map((f, i) => ({ name: `f_${i}`, coef: f.carbs })), { name: 'diag_carbs_def', coef: 1 }, { name: 'diag_carbs_ex', coef: -1 }], bnds: { type: glp.GLP_FX, lb: carbTarget, ub: carbTarget } });

        essentialKeys.forEach((k: string) => {
            if (nutrientConfig[k].max) {
                const varsList = allPool.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) }));
                varsList.push({ name: `diag_max_${k}`, coef: -1 });
                constraints.push({ name: `diag_limit_${k}`, vars: varsList, bnds: { type: glp.GLP_UP, lb: 0, ub: nutrientConfig[k].max } });
            }
        });

        const res = await glp.solve({ name: 'Diagnosis', objective: { direction: glp.GLP_MAX, name: 'obj', vars: objectiveVars }, subjectTo: constraints, bounds: vars });
        
        if (res.result.vars) {
            const v = res.result.vars;
            for (const k of essentialKeys) {
                if (v[`diag_max_${k}`] > 0.1) {
                    return `SAFETY LIMIT EXCEEDED: Your must-have foods already exceed the ${nutrientNames[k] || k} limit by ~${Math.round(v[`diag_max_${k}`])}${nutrientConfig[k].unit || ''}. Try removing some must-have items or increasing the limit in Advanced Settings.`;
                }
            }
            if (v.diag_cal_def > 10) return `CALORIE DEFICIT: Selected foods cannot reach your target. They are short by ~${Math.round(v.diag_cal_def)} kcal. Add more calorie-dense foods.`;
            if (v.diag_cal_ex > 10) return `CALORIE OVERFLOW: Your must-have foods already exceed your calorie target by ~${Math.round(v.diag_cal_ex)} kcal.`;
            if (v.diag_protein_def > 5) return `PROTEIN IMPOSSIBLE: Your protein target (${Math.round(proteinTarget)}g) is too high for the selected foods. Add more lean protein sources.`;
            if (v.diag_protein_ex > 5) return `PROTEIN OVERFLOW: Must-have foods already exceed your protein target.`;
            if (v.diag_fat_ex > 5) return `FAT OVERFLOW: Must-have foods already exceed your fat target (${Math.round(fatTarget)}g).`;
            if (v.diag_carbs_def > 10) return `CARB IMPOSSIBLE: Your carb target is too high for the selected foods. Add more rice, potatoes or fruit.`;
        }
    } catch (e) {}
    return "The combination of must-have foods, safety limits, and macro targets is mathematically impossible. Try relaxing 'Strict' toggles or reducing must-have amounts.";
}

async function run() {
    const configs: Record<string, any> = {
        beast: { specs: 5, trials: 1000, subset: 25, refinements: 10, milpLimit: 15, timeout: 120000 },
        titan: { specs: 10, trials: 5000, subset: 25, refinements: 20, milpLimit: 20, timeout: 240000 },
        olympian: { specs: 15, trials: 15000, subset: 25, refinements: 30, milpLimit: 30, timeout: 480000 },
        god: { specs: 20, trials: 40000, subset: 25, refinements: 50, milpLimit: 40, timeout: 900000 }
    };
    let cfg = configs[details.algoModel || 'beast'] || configs.beast;

    const totalTimeout = setTimeout(() => {
        log("Worker Global Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, cfg.timeout);

    try {
        const likedPool = FOOD_DATABASE.filter((f: Food) => details.likedFoods.includes(f.name) || details.mustHaveFoods.find((m:any)=>m.name===f.name));
        const mustHaveSet = new Set(details.mustHaveFoods.map((m: any) => m.name));

        const specialistMap = new Map<string, Food[]>();
        essentialKeys.forEach((k: string) => {
            const sorted = [...likedPool].sort((a, b) => {
                const getVal = (f: Food) => (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
                return (getVal(b) / (b.calories || 1)) - (getVal(a) / (a.calories || 1));
            });
            specialistMap.set(k, sorted.slice(0, cfg.specs));
        });

        let trialPools: { pool: Food[], score: number }[] = [];
        const trialInterval = Math.max(1, Math.floor(cfg.trials / 20));
        for (let i = 0; i < cfg.trials; i++) {
            const trialNames = new Set([...mustHaveSet]);
            essentialKeys.forEach((k: string) => {
                const options = specialistMap.get(k)!;
                if (options.length > 0) trialNames.add(options[Math.floor(Math.random() * options.length)].name);
            });
            const shuffledLiked = [...likedPool].sort(() => 0.5 - Math.random());
            for (let j = 0; j < shuffledLiked.length && trialNames.size < cfg.subset; j++) trialNames.add(shuffledLiked[j].name);
            const trialPool = FOOD_DATABASE.filter((f: Food) => trialNames.has(f.name));
            
            const res = await solveGLPK(trialPool, false, 'scout', 5);
            if (res.result && (res.result.status === 5 || res.result.status === 2)) {
                const totals = getTotalsFromVars(res.result.vars, trialPool);
                trialPools.push({ pool: trialPool, score: calculateNutrientScore(totals) });
                trialPools.sort((a, b) => b.score - a.score);
                trialPools = trialPools.slice(0, cfg.refinements);
            }
            if (i % trialInterval === 0) parentPort?.postMessage({ type: 'progress', gen: 5 + (i/cfg.trials * 40), accuracy: 0, telemetry: { trialInfo: `Searching Combos ${i}/${cfg.trials}...` } });
        }

        let finalCandidates: any[] = [];
        for (let i = 0; i < trialPools.length; i++) {
            parentPort?.postMessage({ type: 'progress', gen: 45 + (i/trialPools.length * 50), accuracy: finalCandidates[0]?.accuracy || 0, telemetry: { trialInfo: `Refining Combo ${i+1}/${trialPools.length}...` } });
            const res = await solveGLPK(trialPools[i].pool, true, 'strict', cfg.milpLimit);
            if (res.result && res.result.vars) {
                const genome: Record<string, number> = {};
                trialPools[i].pool.forEach((f: Food, idx: number) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                const evalResult = evaluateDiet(genome);
                if (checkDietQuality(evalResult, 'strict').valid) finalCandidates.push(evalResult);
            }
        }

        if (finalCandidates.length === 0) {
            log("Retrying with relaxed pass...");
            for (let i = 0; i < trialPools.length; i++) {
                const res = await solveGLPK(trialPools[i].pool, true, 'strict', cfg.milpLimit);
                if (res.result && res.result.vars) {
                    const genome: Record<string, number> = {};
                    trialPools[i].pool.forEach((f: Food, idx: number) => {
                        const val = res.result.vars[`f_${idx}`] || 0;
                        if (val > 0.001) genome[f.name] = Math.round(val * 100);
                    });
                    const evalResult = evaluateDiet(genome);
                    if (checkDietQuality(evalResult, 'relaxed').valid) finalCandidates.push(evalResult);
                }
            }
        }

        if (finalCandidates.length > 0) {
            finalCandidates.sort((a, b) => b.score - a.score);
            const best = finalCandidates[0];
            clearTimeout(totalTimeout);
            parentPort?.postMessage({ type: 'result', result: { genome: best.genome, targetCalories, actualCalories: Math.round(best.totals.energy), accuracy: best.accuracy, macros: { protein: Math.round(best.totals.protein), carbs: Math.round(best.totals.carbs), fat: Math.round(best.totals.fat) } } });
        } else {
            log("CRITICAL: Failed to find valid diet. Running diagnosis...");
            const reason = await diagnoseFailure(likedPool);
            parentPort?.postMessage({ type: 'result', result: null, error: reason });
        }
    } catch (err: any) {
        log(`FATAL ERROR: ${err.message}`);
        parentPort?.postMessage({ type: 'result', result: null, error: "System Error: " + err.message });
    }
}

run();
