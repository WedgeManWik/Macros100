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

function checkDietQuality(result: any, ceiling: number): { valid: boolean, reason?: string } {
    if (!result || !result.genome || Object.keys(result.genome).length <= 1) {
        return { valid: false, reason: "Too few foods." };
    }
    const totals = result.totals;
    const cals = totals.energy;
    
    const calLB = details.strictCalories ? (targetCalories - 21) : (targetCalories - 21);
    const calUB = details.strictCalories ? (targetCalories + 21) : (targetCalories + 56);
    if (cals < calLB || cals > calUB) return { valid: false, reason: `Calories (${Math.round(cals)}) outside budget.` };

    const pDiff = Math.abs(totals.protein - proteinTarget);
    const fDiff = Math.abs(totals.fat - fatTarget);
    const cDiff = Math.abs(totals.carbs - carbTarget);
    
    const pLimit = details.macros.protein.strict ? 2.1 : 5.6;
    const fLimit = details.macros.fat.strict ? 2.1 : 5.6;
    const cLimit = details.macros.carbs.strict ? 2.1 : 5.6;

    if (pDiff > pLimit || fDiff > fLimit || cDiff > cLimit) {
        return { valid: false, reason: `Macros missed targets.` };
    }

    if (totals.water > 4000) return { valid: false, reason: `Water exceeds limit.` };
    
    for (const k of essentialKeys) {
        if (nutrientConfig[k].max) {
            const actualCeiling = k === 'sugars' ? 1.0 : ceiling;
            if (totals[k] > (nutrientConfig[k].max * actualCeiling + 0.1)) {
                return { valid: false, reason: `${nutrientNames[k] || k} exceeded ${Math.round(actualCeiling*100)}% safety limit.` };
            }
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

async function solveGLPK(foods: Food[], isMILP: boolean, timeLimit: number, ceiling: number, relaxed: boolean = false) {
    try {
        const glp = await GLPK_PROMISE;
        const vars: any[] = [];
        const constraints: any[] = [];
        const binaries: string[] = [];
        const objectiveVars: any[] = [];

        const macroList = [{ name: 'protein', target: proteinTarget }, { name: 'fat', target: fatTarget }, { name: 'carbs', target: carbTarget }];

        vars.push({ name: 'cal_p_dev', lb: 0, ub: 500, type: glp.GLP_DB });
        vars.push({ name: 'cal_n_dev', lb: 0, ub: 500, type: glp.GLP_DB });
        objectiveVars.push({ name: 'cal_p_dev', coef: -1000000 });
        objectiveVars.push({ name: 'cal_n_dev', coef: -1000000 });

        macroList.forEach(m => {
            vars.push({ name: `dev_p_${m.name}`, lb: 0, ub: 100, type: glp.GLP_DB });
            vars.push({ name: `dev_n_${m.name}`, lb: 0, ub: 100, type: glp.GLP_DB });
            objectiveVars.push({ name: `dev_p_${m.name}`, coef: -500000 });
            objectiveVars.push({ name: `dev_n_${m.name}`, coef: -500000 });
        });

        // Sugar Slack (Highest Penalty)
        vars.push({ name: 'sugar_p_dev', lb: 0, ub: 500, type: glp.GLP_DB });
        objectiveVars.push({ name: 'sugar_p_dev', coef: -2000000 }); // More penalized than macros

        essentialKeys.forEach((k: string) => {
            vars.push({ name: `cov_${k}`, lb: 0, ub: 1.0, type: glp.GLP_DB });
            objectiveVars.push({ name: `cov_${k}`, coef: 1000 }); 
        });
        vars.push({ name: 'min_cov', lb: 0, ub: 1.0, type: glp.GLP_DB });
        objectiveVars.push({ name: 'min_cov', coef: 2000 });

        foods.forEach((f, i) => {
            const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
            const customMax = details.customMaxAmounts?.[f.name];
            let minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
            let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : (customMax !== undefined ? (customMax / 100) : (f.maxAmount / 100));
            vars.push({ name: `f_${i}`, lb: (isMILP || !mustHave) ? 0 : minVal, ub: Math.max(minVal, maxVal), type: glp.GLP_DB });
            objectiveVars.push({ name: `f_${i}`, coef: -0.01 }); 
            if (isMILP) {
                vars.push({ name: `u_${i}`, lb: 0, ub: 1, type: glp.GLP_DB });
                binaries.push(`u_${i}`);
                constraints.push({ name: `min_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -minVal }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
                constraints.push({ name: `max_b_${i}`, vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -maxVal }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
                if (mustHave) constraints.push({ name: `force_${i}`, vars: [{ name: `u_${i}`, coef: 1 }], bnds: { type: glp.GLP_FX, lb: 1, ub: 1 } });
            }
        });

        const calVars = foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories }));
        constraints.push({ name: 'c_cal_goal', vars: [...calVars, { name: 'cal_p_dev', coef: -1 }, { name: 'cal_n_dev', coef: 1 }], bnds: { type: glp.GLP_FX, lb: targetCalories, ub: targetCalories } });
        
        if (!relaxed) {
            const calLB = details.strictCalories ? (targetCalories - 20) : (targetCalories - 20);
            const calUB = details.strictCalories ? (targetCalories + 20) : (targetCalories + 55);
            constraints.push({ name: 'c_cal_hard', vars: calVars, bnds: { type: glp.GLP_DB, lb: calLB, ub: calUB } });
        }

        macroList.forEach(m => {
            const mVars = foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] }));
            constraints.push({ name: `macro_goal_${m.name}`, vars: [...mVars, { name: `dev_p_${m.name}`, coef: -1 }, { name: `dev_n_${m.name}`, coef: 1 }], bnds: { type: glp.GLP_FX, lb: m.target, ub: m.target } });
            
            if (!relaxed) {
                const limit = details.macros[m.name as 'protein'|'carbs'|'fat'].strict ? 2.0 : 5.5;
                constraints.push({ name: `macro_hard_${m.name}`, vars: mVars, bnds: { type: glp.GLP_DB, lb: m.target - limit, ub: m.target + limit } });
            }
        });

        essentialKeys.forEach((k: string) => {
            const config = nutrientConfig[k];
            const foodCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) / (config.target || 1) }));
            constraints.push({ name: `lk_cov_${k}`, vars: [...foodCoeffs, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
            constraints.push({ name: `lk_min_${k}`, vars: [{ name: 'min_cov', coef: 1 }, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
            
            if (config.max) {
                const actualCeiling = k === 'sugars' ? 1.0 : ceiling;
                constraints.push({ name: `max_${k}`, vars: foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) })), bnds: { type: glp.GLP_UP, lb: 0, ub: config.max * actualCeiling } });
            }
        });

        // Sugar hard goal constraint (uses the penalized slack)
        const sugarVars = foods.map((f, i) => ({ name: `f_${i}`, coef: f.nutrients?.sugars || 0 }));
        constraints.push({ 
            name: 'c_sugar_goal', 
            vars: [...sugarVars, { name: 'sugar_p_dev', coef: -1 }], 
            bnds: { type: glp.GLP_UP, lb: 0, ub: nutrientConfig.sugars.max } 
        });

        return await glp.solve({ name: 'DietPlanner', objective: { direction: glp.GLP_MAX, name: 'score', vars: objectiveVars }, subjectTo: constraints, bounds: vars, binaries: binaries, options: { presol: true, tmlim: timeLimit } });
    } catch (err: any) {
        return { result: { status: 0, error: err.message } };
    }
}

async function diagnoseFailure(allPool: Food[], ceiling: number) {
    try {
        const glp = await GLPK_PROMISE;
        const mustHaves = details.mustHaveFoods || [];
        
        const getMustHaveTotals = () => {
            const totals: any = { energy: 0, protein: 0, carbs: 0, fat: 0 };
            Object.keys(nutrientConfig).forEach(k => totals[k] = 0);
            mustHaves.forEach((m: any) => {
                const f = foodMap.get(m.name);
                if (f) {
                    const r = m.min / 100;
                    totals.energy += r * f.calories;
                    totals.protein += r * f.protein;
                    totals.carbs += r * f.carbs;
                    totals.fat += r * f.fat;
                    if (f.nutrients) for (const n in f.nutrients) if (totals[n] !== undefined) totals[n] += r * (f.nutrients[n] || 0);
                }
            });
            return totals;
        };

        const findBestSources = (macro: string, mode: 'high'|'low' = 'high') => {
            return allPool
                .filter(f => (f as any)[macro] !== undefined)
                .sort((a, b) => {
                    const valA = (a as any)[macro] / (a.calories || 1);
                    const valB = (b as any)[macro] / (b.calories || 1);
                    return mode === 'high' ? valB - valA : valA - valB;
                })
                .slice(0, 3).map(f => f.name).join(", ");
        };

        const mTotals = getMustHaveTotals();

        // PHASE 1: DIRECT MUST-HAVE CONTRADICTIONS
        // Check if must-haves alone break the rules
        if (mTotals.energy > targetCalories + 20) return `CALORIE CONTRADICTION: Your must-have foods alone total ~${Math.round(mTotals.energy)} kcal, exceeding your ${Math.round(targetCalories)} kcal target. Try reducing mandatory portions.`;
        if (mTotals.protein > proteinTarget + 5) return `PROTEIN CONTRADICTION: Your must-have foods contain ~${Math.round(mTotals.protein)}g protein, already exceeding your ${Math.round(proteinTarget)}g goal.`;
        if (mTotals.carbs > carbTarget + 5) return `CARB CONTRADICTION: Your must-have foods contain ~${Math.round(mTotals.carbs)}g carbs, already exceeding your ${Math.round(carbTarget)}g goal. This is common in Keto profiles with too many mandatory vegetables or fruit.`;
        if (mTotals.fat > fatTarget + 5) return `FAT CONTRADICTION: Your must-have foods contain ~${Math.round(mTotals.fat)}g fat, already exceeding your ${Math.round(fatTarget)}g goal.`;

        for (const k of essentialKeys) {
            if (nutrientConfig[k].max && mTotals[k] > (nutrientConfig[k].max * ceiling + 0.1)) {
                const name = nutrientNames[k] || k;
                let topContrib = ""; let maxC = 0;
                mustHaves.forEach((m:any) => {
                    const f = foodMap.get(m.name);
                    const val = (k==='energy'?f?.calories:k==='protein'?f?.protein:k==='carbs'?f?.carbs:k==='fat'?f?.fat:(f?.nutrients[k] as any)) || 0;
                    if (val * (m.min/100) > maxC) { maxC = val * (m.min/100); topContrib = m.name; }
                });
                return `${name.toUpperCase()} SAFETY CONTRADICTION: Your must-have foods exceed the ${Math.round(ceiling*100)}% safety limit for ${name}. ${topContrib} is the biggest contributor.`;
            }
        }

        // PHASE 2: SOLVER-BASED DEEP AUDIT
        const vars: any[] = [];
        const constraints: any[] = [];
        const objectiveVars: any[] = [];

        // Diagnostic Slacks
        vars.push({ name: 'diag_cal_def', lb: 0, ub: 5000, type: glp.GLP_DB }, { name: 'diag_cal_ex', lb: 0, ub: 5000, type: glp.GLP_DB });
        objectiveVars.push({ name: 'diag_cal_def', coef: -1000000 }, { name: 'diag_cal_ex', coef: -1000000 });

        ['protein', 'fat', 'carbs'].forEach(m => {
            vars.push({ name: `diag_${m}_def`, lb: 0, ub: 500, type: glp.GLP_DB }, { name: `diag_${m}_ex`, lb: 0, ub: 500, type: glp.GLP_DB });
            objectiveVars.push({ name: `diag_${m}_def`, coef: -1000000 }, { name: `diag_${m}_ex`, coef: -1000000 });
        });

        essentialKeys.forEach((k: string) => {
            if (nutrientConfig[k].max) {
                vars.push({ name: `diag_max_${k}`, lb: 0, ub: 1000000, type: glp.GLP_DB });
                objectiveVars.push({ name: `diag_max_${k}`, coef: -1000000000 });
            }
        });

        allPool.forEach((f, i) => {
            const mustHave = mustHaves.find((m: any) => m.name === f.name);
            const customMax = details.customMaxAmounts?.[f.name];
            let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : (customMax !== undefined ? (customMax / 100) : (f.maxAmount / 100));
            vars.push({ name: `f_${i}`, lb: (mustHave ? (mustHave.min || 0) : 0) / 100, ub: Math.max(50, maxVal), type: glp.GLP_DB });
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
                constraints.push({ name: `diag_limit_${k}`, vars: varsList, bnds: { type: glp.GLP_UP, lb: 0, ub: nutrientConfig[k].max * ceiling } });
            }
        });

        const res = await glp.solve({ name: 'Diagnosis', objective: { direction: glp.GLP_MAX, name: 'obj', vars: objectiveVars }, subjectTo: constraints, bounds: vars });
        if (res.result.vars) {
            const v = res.result.vars;
            
            // 1. Check if safety limit prevents hitting a macro
            for (const k of essentialKeys) {
                if (v[`diag_max_${k}`] > 0.1) {
                    const name = nutrientNames[k] || k;
                    return `SAFETY BOTTLENECK: To hit your macro targets, the algorithm needs to pick foods that would exceed your ${name} safety limit. Try relaxing your macro goals or adding different types of foods to your liked list.`;
                }
            }

            // 2. Complex Macro Deficits (The pool is insufficient)
            if (v.diag_protein_def > 5) return `PROTEIN INFEASIBLE: Your selected foods don't have enough protein density to hit ${Math.round(proteinTarget)}g within your calorie budget. Add leaner protein like: ${findBestSources('protein')}.`;
            if (v.diag_fat_def > 5) return `FAT INFEASIBLE: Your selected foods are too lean to hit ${Math.round(fatTarget)}g fat. Add fatty foods like: ${findBestSources('fat')}.`;
            if (v.diag_carbs_def > 5) return `CARB INFEASIBLE: Your selected foods don't have enough carbs to hit ${Math.round(carbTarget)}g. Add carb-dense foods like: ${findBestSources('carbs')}.`;

            // 3. Complex Macro Overflows (The pool is too dense)
            if (v.diag_protein_ex > 5) return `PROTEIN OVERFLOW: Every possible combination of your liked foods that hits your other targets results in too much protein. Add more protein-free foods (fats/carbs) or reduce meat portions.`;
            if (v.diag_fat_ex > 5) return `FAT OVERFLOW: Every possible combination exceeds your fat goal. Add leaner foods like: ${findBestSources('fat', 'low')}.`;
            if (v.diag_carbs_ex > 5) return `CARB OVERFLOW: Every possible combination exceeds your carb goal. Add lower-carb options like: ${findBestSources('carbs', 'low')}.`;

            if (v.diag_cal_def > 10) return `CALORIE DEFICIT: Even at maximum portions, your liked foods cannot reach ${Math.round(targetCalories)} kcal. Add calorie-dense foods.`;
        }
    } catch (e) {}
    return "Mathematically impossible combination. Try relaxing 'Strict' toggles, reducing must-have portions, or adding more variety to your liked foods list.";
}

async function run() {
    try {
        const mustHaveNames = (details.mustHaveFoods || []).map((m: any) => m.name);
        const likedPool = FOOD_DATABASE.filter((f: Food) => details.likedFoods.includes(f.name) || mustHaveNames.includes(f.name));
        
        log(`Analyzing ${likedPool.length} foods...`);

        const ceilings = [0.8, 0.85, 0.9, 0.95, 1.0];
        let bestCeiling = 1.0;
        let globalRes: any = null;

        for (const c of ceilings) {
            log(`Testing safety ceiling: ${Math.round(c*100)}%...`);
            const res = await solveGLPK(likedPool, false, 500, c);
            if (res.result && (res.result.status === 5 || res.result.status === 2)) {
                bestCeiling = c;
                globalRes = res;
                break;
            }
        }

        if (!globalRes) {
            const reason = await diagnoseFailure(likedPool, 1.0);
            parentPort?.postMessage({ type: 'result', result: null, error: reason });
            return;
        }

        const heroFoods = new Set<string>(mustHaveNames);
        Object.entries(globalRes.result.vars || {}).forEach(([name, val]: [string, any]) => {
            if (name.startsWith('f_') && val > 0.01) {
                const idx = parseInt(name.split('_')[1]);
                heroFoods.add(likedPool[idx].name);
            }
        });

        log(`Identified ${heroFoods.size} key foods at ${Math.round(bestCeiling*100)}% safety. Refining...`);

        let finalCandidates: any[] = [];
        const subsetCount = details.algoModel === 'beast' ? 10 : details.algoModel === 'titan' ? 30 : 60;
        
        for (let i = 0; i < subsetCount; i++) {
            const trialSet = new Set(heroFoods);
            const shuffled = [...likedPool].sort(() => 0.5 - Math.random());
            for (let j = 0; j < shuffled.length && trialSet.size < 40; j++) trialSet.add(shuffled[j].name);
            
            const trialPool = FOOD_DATABASE.filter((f: Food) => trialSet.has(f.name));
            const res = await solveGLPK(trialPool, true, 1000, bestCeiling);
            
            if (res.result && res.result.vars) {
                const genome: Record<string, number> = {};
                trialPool.forEach((f: Food, idx: number) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                const totals = getTotalsFromVars(res.result.vars, trialPool);
                const score = calculateNutrientScore(totals);
                const evalRes = { totals, genome, score, accuracy: Math.round((score / essentialKeys.length) * 1000) / 10 };
                if (checkDietQuality(evalRes, bestCeiling).valid) finalCandidates.push(evalRes);
            }
            if (i % 5 === 0) parentPort?.postMessage({ type: 'progress', gen: 10 + (i/subsetCount * 80), accuracy: finalCandidates[0]?.accuracy || 0 });
        }

        if (finalCandidates.length > 0) {
            finalCandidates.sort((a, b) => b.score - a.score);
            const best = finalCandidates[0];
            parentPort?.postMessage({ type: 'result', result: { genome: best.genome, targetCalories, actualCalories: Math.round(best.totals.energy), accuracy: best.accuracy, macros: { protein: Math.round(best.totals.protein), carbs: Math.round(best.totals.carbs), fat: Math.round(best.totals.fat) } } });
        } else {
            // BEST EFFORT FALLBACK
            log("No perfect diet found. Generating best-effort plan...");
            const reason = await diagnoseFailure(likedPool, bestCeiling);
            
            // Re-solve the full pool in relaxed mode to get the absolute closest fit for the UI
            const finalBestEffort = await solveGLPK(likedPool, false, 1000, 1.0, true);
            if (finalBestEffort.result && finalBestEffort.result.vars) {
                const genome: Record<string, number> = {};
                likedPool.forEach((f: Food, idx: number) => {
                    const val = finalBestEffort.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                const totals = getTotalsFromVars(finalBestEffort.result.vars, likedPool);
                const score = calculateNutrientScore(totals);
                const accuracy = Math.round((score / essentialKeys.length) * 1000) / 10;
                
                parentPort?.postMessage({ 
                    type: 'result', 
                    result: { 
                        genome, 
                        targetCalories, 
                        actualCalories: Math.round(totals.energy), 
                        accuracy, 
                        macros: { protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat) } 
                    },
                    error: reason
                });
            } else {
                parentPort?.postMessage({ type: 'result', result: null, error: reason });
            }
        }
    } catch (err: any) {
        parentPort?.postMessage({ type: 'result', result: null, error: "System Error: " + err.message });
    }
}

run();
