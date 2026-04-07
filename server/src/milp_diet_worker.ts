import { parentPort, workerData } from 'worker_threads';
// @ts-ignore
import glpkModule from 'glpk.js/node';
import { Food, NutrientConfig } from './types.js';

function log(msg: string) {
    console.log(`[MILP Worker] ${msg}`);
    parentPort?.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: msg } });
}

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData as {
    FOOD_DATABASE: Food[],
    details: any,
    targetCalories: number,
    proteinTarget: number,
    fatTarget: number,
    carbTarget: number,
    essentialKeys: string[],
    nutrientNames: Record<string, string>,
    nutrientConfig: Record<string, NutrientConfig>
};

// Apply user requested 90% safety margin globally to all nutrient upper bounds
// We skip 'energy' because its target is very close to its max, and reducing it would make the problem infeasible.
Object.keys(nutrientConfig).forEach(k => {
    if (k !== 'energy' && nutrientConfig[k].max) {
        nutrientConfig[k].max *= 0.9;
    }
});

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
    
    // CALORIES: Always Hard
    const calLB = details.strictCalories ? (targetCalories - 21) : (targetCalories - 21);
    const calUB = details.strictCalories ? (targetCalories + 21) : (targetCalories + 56);
    if (cals < calLB || cals > calUB) return { valid: false, reason: `Calories (${Math.round(cals)}) outside budget.` };

    // MACROS: Hard in strict passes
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
    
    // SAFETY: Hard in strict passes
    for (const k of Object.keys(nutrientConfig)) {
        if (nutrientConfig[k].max) {
            const actualCeiling = ceiling;
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

        // 1. HARD CALORIE CONSTRAINTS (Never Relaxed)
        const calVars = foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories }));
        constraints.push({ name: 'c_cal_goal', vars: [...calVars], bnds: { type: glp.GLP_FX, lb: targetCalories, ub: targetCalories } });
        // Use a small slack just for the objective, but the hard bound is what matters
        vars.push({ name: 'cal_p_dev', lb: 0, ub: 100, type: glp.GLP_DB });
        vars.push({ name: 'cal_n_dev', lb: 0, ub: 100, type: glp.GLP_DB });
        objectiveVars.push({ name: 'cal_p_dev', coef: -1000000 }, { name: 'cal_n_dev', coef: -1000000 });
        // Update cal goal to use slacks
        constraints[constraints.length-1].vars.push({ name: 'cal_p_dev', coef: -1 }, { name: 'cal_n_dev', coef: 1 });

        const calLB = details.strictCalories ? (targetCalories - 20) : (targetCalories - 20);
        const calUB = details.strictCalories ? (targetCalories + 20) : (targetCalories + 55);
        constraints.push({ name: 'c_cal_hard', vars: calVars, bnds: { type: glp.GLP_DB, lb: calLB, ub: calUB } });

        // 2. MACRO CONSTRAINTS (Soft in relaxed mode)
        const macroList = [{ name: 'protein', target: proteinTarget }, { name: 'fat', target: fatTarget }, { name: 'carbs', target: carbTarget }];
        macroList.forEach(m => {
            const mVars = foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] }));
            vars.push({ name: `dev_p_${m.name}`, lb: 0, ub: 200, type: glp.GLP_DB });
            vars.push({ name: `dev_n_${m.name}`, lb: 0, ub: 200, type: glp.GLP_DB });
            objectiveVars.push({ name: `dev_p_${m.name}`, coef: -500000 }, { name: `dev_n_${m.name}`, coef: -500000 });
            
            constraints.push({ 
                name: `macro_goal_${m.name}`, 
                vars: [...mVars, { name: `dev_p_${m.name}`, coef: -1 }, { name: `dev_n_${m.name}`, coef: 1 }], 
                bnds: { type: glp.GLP_FX, lb: m.target, ub: m.target } 
            });

            if (!relaxed) {
                const limit = details.macros[m.name as 'protein'|'carbs'|'fat'].strict ? 2.0 : 5.5;
                constraints.push({ name: `macro_hard_${m.name}`, vars: mVars, bnds: { type: glp.GLP_DB, lb: m.target - limit, ub: m.target + limit } });
            }
        });

        // 3. SAFETY LIMITS (Soft penalized in relaxed mode)
        Object.keys(nutrientConfig).forEach((k: string) => {
            const config = nutrientConfig[k];
            const isEssential = essentialKeys.includes(k);

            if (isEssential) {
                const foodCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) / (config.target || 1) }));
                constraints.push({ name: `lk_cov_${k}`, vars: [...foodCoeffs, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_LO, lb: 0, ub: 0 } });
                constraints.push({ name: `lk_min_${k}`, vars: [{ name: 'min_cov', coef: 1 }, { name: `cov_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: 0 } });
            }
            
            if (config.max) {
                const actualCeiling = ceiling;
                const limit = config.max * actualCeiling;
                const totalCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0)) }));
                
                if (relaxed) {
                    vars.push({ name: `max_dev_${k}`, lb: 0, ub: 100000, type: glp.GLP_DB });
                    objectiveVars.push({ name: `max_dev_${k}`, coef: -800000 }); // High penalty for safety breach
                    constraints.push({ name: `max_${k}`, vars: [...totalCoeffs, { name: `max_dev_${k}`, coef: -1 }], bnds: { type: glp.GLP_UP, lb: 0, ub: limit } });
                } else {
                    constraints.push({ name: `max_${k}`, vars: totalCoeffs, bnds: { type: glp.GLP_UP, lb: 0, ub: limit } });
                }
            }
        });

        // 4. FOODS & PORTIONS (Always Hard)
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

        essentialKeys.forEach((k: string) => {
            vars.push({ name: `cov_${k}`, lb: 0, ub: 1.0, type: glp.GLP_DB });
            objectiveVars.push({ name: `cov_${k}`, coef: 1000 }); 
        });
        vars.push({ name: 'min_cov', lb: 0, ub: 1.0, type: glp.GLP_DB });
        objectiveVars.push({ name: 'min_cov', coef: 2000 });

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

        if (mTotals.energy > targetCalories + 20) return `CALORIE CONTRADICTION: Your must-have foods alone total ~${Math.round(mTotals.energy)} kcal, exceeding your ${Math.round(targetCalories)} kcal target. Try reducing mandatory portions.`;
        if (mTotals.protein > proteinTarget + 5) return `PROTEIN CONTRADICTION: Your must-have foods contain ~${Math.round(mTotals.protein)}g protein, already exceeding your ${Math.round(proteinTarget)}g goal.`;
        if (mTotals.carbs > carbTarget + 5) return `CARB CONTRADICTION: Your must-have foods contain ~${Math.round(mTotals.carbs)}g carbs, already exceeding your ${Math.round(carbTarget)}g goal. This is common in Keto profiles with too many mandatory vegetables or fruit.`;
        if (mTotals.fat > fatTarget + 5) return `FAT CONTRADICTION: Your must-have foods contain ~${Math.round(mTotals.fat)}g fat, already exceeding your ${Math.round(fatTarget)}g goal.`;

        for (const k of Object.keys(nutrientConfig)) {
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

        const vars: any[] = [];
        const constraints: any[] = [];
        const objectiveVars: any[] = [];

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
            for (const k of essentialKeys) {
                if (v[`diag_max_${k}`] > 0.1) {
                    const name = nutrientNames[k] || k;
                    return `SAFETY BOTTLENECK: To hit your macro targets, the algorithm needs to pick foods that would exceed your ${name} safety limit. Try relaxing your macro goals or adding different types of foods to your liked list.`;
                }
            }
            if (v.diag_protein_def > 5) return `PROTEIN INFEASIBLE: Your selected foods don't have enough protein density to hit ${Math.round(proteinTarget)}g within your calorie budget. Add leaner protein like: ${findBestSources('protein')}.`;
            if (v.diag_fat_def > 5) return `FAT INFEASIBLE: Your selected foods are too lean to hit ${Math.round(fatTarget)}g fat. Add fatty foods like: ${findBestSources('fat')}.`;
            if (v.diag_carbs_def > 5) return `CARB INFEASIBLE: Your selected foods don't have enough carbs to hit ${Math.round(carbTarget)}g. Add carb-dense foods like: ${findBestSources('carbs')}.`;
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
        const uniqueFoodNames = new Set([...details.likedFoods, ...mustHaveNames]);
        
        if (uniqueFoodNames.size < 5) {
            parentPort?.postMessage({ 
                type: 'result', 
                result: null, 
                error: "You need to select more foods! Please pick at least 5 different foods to allow the algorithm to find a balanced combination." 
            });
            return;
        }

        const likedPool = FOOD_DATABASE.filter((f: Food) => uniqueFoodNames.has(f.name));
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
            // Check if a relaxed solve works (macros/safety soft, calories hard)
            const relaxedCheck = await solveGLPK(likedPool, false, 500, 1.0, true);
            if (!relaxedCheck.result || (relaxedCheck.result.status !== 5 && relaxedCheck.result.status !== 2)) {
                const reason = await diagnoseFailure(likedPool, 1.0);
                parentPort?.postMessage({ type: 'result', result: null, error: reason });
                return;
            }
            globalRes = relaxedCheck;
        }

        const heroFoods = new Set<string>(mustHaveNames);
        Object.entries(globalRes.result.vars || {}).forEach(([name, val]: [string, any]) => {
            if (name.startsWith('f_') && val > 0.01) {
                const idx = parseInt(name.split('_')[1]);
                heroFoods.add(likedPool[idx].name);
            }
        });

        log(`Identified ${heroFoods.size} key foods. Refining using ${details.algoModel || 'default'} model...`);

        let finalCandidates: any[] = [];
        
        // Configuration mapping
        const algoModel = details.algoModel || 'beast';
        let subsetCount = algoModel === 'beast' ? 15 : algoModel === 'titan' ? 40 : algoModel === 'olympian' ? 80 : 150;
        let solverTimeLimit = algoModel === 'beast' ? 1000 : algoModel === 'titan' ? 2000 : algoModel === 'olympian' ? 4000 : 8000;
        const trialLimit = algoModel === 'beast' ? 40 : algoModel === 'titan' ? 50 : algoModel === 'olympian' ? 60 : 80;

        // Respect Benchmark overrides if present
        if (details.benchConfig) {
            subsetCount = details.benchConfig.subset || subsetCount;
            solverTimeLimit = details.benchConfig.trials || solverTimeLimit;
            log(`Benchmark Override: Subsets=${subsetCount}, TimeLimit=${solverTimeLimit}`);
        }
        
        for (let i = 0; i < subsetCount; i++) {
            const trialSet = new Set(heroFoods);
            const shuffled = [...likedPool].sort(() => 0.5 - Math.random());
            for (let j = 0; j < shuffled.length && trialSet.size < trialLimit; j++) trialSet.add(shuffled[j].name);
            const trialPool = FOOD_DATABASE.filter((f: Food) => trialSet.has(f.name));
            const res = await solveGLPK(trialPool, true, solverTimeLimit, bestCeiling);
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
            log(`Refinement complete. Found ${finalCandidates.length} valid diets. Picking the best one...`);
            finalCandidates.sort((a, b) => b.score - a.score);
            const best = finalCandidates[0];
            parentPort?.postMessage({ type: 'result', result: { genome: best.genome, targetCalories, actualCalories: Math.round(best.totals.energy), accuracy: best.accuracy, macros: { protein: Math.round(best.totals.protein), carbs: Math.round(best.totals.carbs), fat: Math.round(best.totals.fat) } } });
            return;
        }

        // BEST EFFORT FALLBACK
        const isGodMode = algoModel === 'god';
        const fallbackSubsets = algoModel === 'beast' ? 1 : algoModel === 'titan' ? 20 : algoModel === 'olympian' ? 80 : 250;
        const totalFallbackTime = algoModel === 'beast' ? 3000 : algoModel === 'titan' ? 8000 : algoModel === 'olympian' ? 15000 : 45000;
        
        log(`No perfect diet found. Running deep ${fallbackSubsets}-trial stochastic search for best-effort plan...`);
        
        const reason = await diagnoseFailure(likedPool, bestCeiling);
        let bestEffortCandidate: any = null;

        for (let i = 0; i < fallbackSubsets; i++) {
            // Stochastic subset selection: For God Mode, force variety by occasionally excluding foods
            const trialSet = new Set(heroFoods);
            const shuffled = [...likedPool].sort(() => 0.5 - Math.random());
            
            // God Mode: Randomly exclude 10% of foods in each trial to force different combinations
            const poolSizeLimit = isGodMode ? Math.floor(likedPool.length * 0.9) : trialLimit;
            
            for (let j = 0; j < shuffled.length && trialSet.size < poolSizeLimit; j++) {
                // Stochastic skip logic for God Mode variety
                if (isGodMode && Math.random() < 0.1 && !heroFoods.has(shuffled[j].name)) continue;
                trialSet.add(shuffled[j].name);
            }
            
            const trialPool = FOOD_DATABASE.filter((f: Food) => trialSet.has(f.name));
            
            // Randomize safety ceiling slightly for each trial in higher models
            const passCeiling = algoModel === 'beast' ? 1.0 : (1.0 + (Math.random() * 0.3));
            
            // Solve with deep search
            const res = await solveGLPK(trialPool, true, Math.floor(totalFallbackTime / fallbackSubsets), passCeiling, true);
            
            if (res.result && res.result.vars) {
                const genome: Record<string, number> = {};
                trialPool.forEach((f: Food, idx: number) => {
                    const val = res.result.vars[`f_${idx}`] || 0;
                    if (val > 0.001) genome[f.name] = Math.round(val * 100);
                });
                const totals = getTotalsFromVars(res.result.vars, trialPool);
                const score = calculateNutrientScore(totals);
                const accuracy = Math.round((score / essentialKeys.length) * 1000) / 10;
                
                if (!bestEffortCandidate || accuracy > bestEffortCandidate.accuracy) {
                    bestEffortCandidate = { 
                        genome, targetCalories, 
                        actualCalories: Math.round(totals.energy), 
                        accuracy, 
                        macros: { protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat) } 
                    };
                }
            }
            
            if (i % (isGodMode ? 20 : 5) === 0) {
                parentPort?.postMessage({ 
                    type: 'progress', 
                    gen: 90 + (i/fallbackSubsets * 10), 
                    accuracy: bestEffortCandidate?.accuracy || 0,
                    telemetry: { trialInfo: `Best-Effort Trial ${i}/${fallbackSubsets} | Accuracy: ${bestEffortCandidate?.accuracy || 0}%` }
                });
            }
        }

        if (bestEffortCandidate) {
            log(`Deep search complete. Found optimal best-effort plan with ${bestEffortCandidate.accuracy}% accuracy.`);
            parentPort?.postMessage({ type: 'result', result: bestEffortCandidate, error: reason });
        } else {
            parentPort?.postMessage({ type: 'result', result: null, error: reason });
        }
    } catch (err: any) {
        parentPort?.postMessage({ type: 'result', result: null, error: "System Error: " + err.message });
    }
}

run();
