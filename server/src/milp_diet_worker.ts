import { parentPort, workerData } from 'worker_threads';
// @ts-ignore
import glpkModule from 'glpk.js/node';
import { Food, NutrientConfig } from './types.js';

console.log("[MILP Worker] Script execution started - VERSION 9.0 (ELASTIC-RESOLVER)");

function log(msg: string) {
    console.log(`[MILP Worker] ${msg}`);
    parentPort?.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: msg } });
}

let FOOD_DATABASE: Food[], details: any, targetCalories: number, 
    proteinTarget: number, fatTarget: number, carbTarget: number, 
    essentialKeys: string[], nutrientNames: Record<string, string>, 
    nutrientConfig: Record<string, NutrientConfig>;

try {
    const data = workerData as any;
    FOOD_DATABASE = data.FOOD_DATABASE;
    details = data.details;
    targetCalories = data.targetCalories; 
    proteinTarget = data.proteinTarget;
    fatTarget = data.fatTarget;
    carbTarget = data.carbTarget;
    essentialKeys = data.essentialKeys;
    nutrientNames = data.nutrientNames;
    nutrientConfig = data.nutrientConfig;
} catch (e) {
    process.exit(1);
}

const GLPK_PROMISE = (glpkModule as any)();

function getNutrientValue(f: Food, k: string): number {
    if (k === 'energy') return f.calories;
    if (k === 'protein') return f.protein;
    if (k === 'carbs') return f.carbs;
    if (k === 'fat') return f.fat;
    if (k === 'net_carbs') return Math.max(0, f.carbs - (f.nutrients['fiber'] || 0));
    
    const dbKeyMapping: Record<string, string> = {
        b12: 'b12', iron: 'iron', calcium: 'calcium', magnesium: 'magnesium',
        zinc: 'zinc', vitamin_a: 'a', vitamin_c: 'c', vitamin_d: 'd',
        vitamin_e: 'e', vitamin_k: 'k', folate: 'folate'
    };

    const key = dbKeyMapping[k] || k;
    return f.nutrients[key] || f.nutrients[k] || 0;
}

function calculateMacroScore(totals: any) {
    const pDev = Math.abs(totals.protein - proteinTarget);
    const fDev = Math.abs(totals.fat - fatTarget);
    const cDev = Math.abs(totals.carbs - carbTarget);
    const calDev = Math.abs(totals.energy - targetCalories);
    // Return a negative score (penalty)
    return -(pDev * 10 + fDev * 5 + cDev * 5 + (calDev / 2));
}

function calculateNutrientScore(totals: any) {
    let score = 0;
    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        const target = config.target || 1;
        const optMin = config.optimalMin || target;
        const optMax = config.optimalMax || target;
        const val = totals[k] || 0;
        
        if (val < target) {
            score += val / target; // 0.0 to 1.0
        } else if (val < optMin) {
            // between target and optimalMin (1.0 to 1.2)
            score += 1.0 + 0.2 * ((val - target) / (optMin - target));
        } else if (val <= optMax) {
            // sweet spot: full optimal score
            score += 1.2;
        } else if (config.max && val > optMax && val <= config.max) {
            // between optimalMax and max (1.2 down to 1.0)
            score += 1.2 - 0.2 * ((val - optMax) / (config.max - optMax));
        } else {
            score += 1.0; // above max, cap at 1.0
        }
    });
    return score;
}

function getTotalsFromVars(vars: any, pool: Food[]) {
    const totals: any = { energy: 0, protein: 0, carbs: 0, fat: 0 };
    Object.keys(nutrientConfig).forEach(k => totals[k] = 0);
    if (!vars) return totals;
    pool.forEach((f, i) => {
        const amt = vars[`f_${i}`] || 0;
        if (amt <= 0.0001) return;
        totals.energy += amt * f.calories;
        totals.protein += amt * f.protein;
        totals.carbs += amt * f.carbs;
        totals.fat += amt * f.fat;
        Object.keys(nutrientConfig).forEach(k => { totals[k] += amt * getNutrientValue(f, k); });
    });
    return totals;
}

async function solveGLPK(foods: Food[], isMILP: boolean, timeLimit: number, headroomMultiplier: number = 1.0) {
    try {
        const glp = await GLPK_PROMISE;
        const vars: any[] = [];
        const constraints: any[] = [];
        const binaries: string[] = [];
        const objectiveVars: any[] = [];

        // --- 1. CORE VARIABLES (Food Amounts) & SEMI-CONTINUOUS CONSTRAINTS ---
        foods.forEach((f, i) => {
            const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
            const customMax = details.customMaxAmounts?.[f.name];
            
            const minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : 0) / 100;
            let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : (customMax !== undefined ? (customMax / 100) : (f.maxAmount / 100));
            
            // maxAmount is strict. We do not apply headroom to it anymore to ensure realistic portions.
            // maxVal *= headroomMultiplier;
            // Continuous food variable: if it's mustHave, lower bound is minVal. Otherwise 0.
            const continuousLb = mustHave ? minVal : 0;
            vars.push({ name: `f_${i}`, lb: continuousLb, ub: maxVal, type: glp.GLP_DB });
            // Minimize total food weight slightly
            objectiveVars.push({ name: `f_${i}`, coef: 0.001 }); 

            // Enforce minimum portion size using binary indicator variable y_i
            if (isMILP && !mustHave) {
                const minPortion = (f.minAmount || 0) / 100;
                if (minPortion > 0) {
                    binaries.push(`y_${i}`);
                    vars.push({ name: `y_${i}`, lb: 0, ub: 1, type: glp.GLP_DB });
                    
                    // Reward for variety: encourage picking more unique foods (equivalent to ~5 kcal leniency)
                    objectiveVars.push({ name: `y_${i}`, coef: -500 });

                    // Constraint: f_i >= minPortion * y_i => f_i - minPortion * y_i >= 0
                    constraints.push({
                        name: `min_portion_limit_${i}`,
                        vars: [
                            { name: `f_${i}`, coef: 1 },
                            { name: `y_${i}`, coef: -minPortion }
                        ],
                        bnds: { type: glp.GLP_LO, lb: 0, ub: 0 }
                    });

                    // Constraint: f_i <= maxVal * y_i => f_i - maxVal * y_i <= 0
                    constraints.push({
                        name: `max_portion_limit_${i}`,
                        vars: [
                            { name: `f_${i}`, coef: 1 },
                            { name: `y_${i}`, coef: -maxVal }
                        ],
                        bnds: { type: glp.GLP_UP, lb: 0, ub: 0 }
                    });
                }
            }
        });

        // --- 2. ELASTIC TARGETS (Soft Constraints) ---
        const addElasticTarget = (name: string, currentValVars: {name: string, coef: number}[], target: number, penalty: number) => {
            // Objective: Minimize deviation
            // We penalize the absolute value of slack by splitting it into p/n
            vars.push({ name: `p_slack_${name}`, lb: 0, ub: 10000000, type: glp.GLP_DB }); 
            vars.push({ name: `n_slack_${name}`, lb: 0, ub: 10000000, type: glp.GLP_DB }); 
            
            objectiveVars.push({ name: `p_slack_${name}`, coef: penalty });
            objectiveVars.push({ name: `n_slack_${name}`, coef: penalty });

            // CurrentSum - P_Slack + N_Slack = Target
            constraints.push({ 
                name: `target_${name}`, 
                vars: [...currentValVars, { name: `p_slack_${name}`, coef: -1 }, { name: `n_slack_${name}`, coef: 1 }], 
                bnds: { type: glp.GLP_FX, lb: target, ub: target } 
            });
        };

        const calCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories }));
        addElasticTarget('cal', calCoeffs, targetCalories, 1000); 

        ['protein', 'fat', 'carbs'].forEach(m => {
            const target = m === 'protein' ? proteinTarget : (m === 'fat' ? fatTarget : carbTarget);
            const mCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m] }));
            
            let penalty = 2000;
            const strictness = details.macros?.[m]?.strictness;
            if (strictness === 'strict') penalty = 10000000;
            else if (strictness === 'relaxed') penalty = 2000;
            else if (strictness === 'none') penalty = 100;

            addElasticTarget(m, mCoeffs, target, penalty); 
        });

        // --- 2b. DIET VARIETY LIMITS (Unique Foods Count) ---
        if (isMILP && (details.minFoods !== undefined || details.maxFoods !== undefined)) {
            const countMustHave = details.mustHaveFoods?.length || 0;
            const minNonMustHave = Math.max(0, (details.minFoods || 20) - countMustHave);
            const maxNonMustHave = Math.max(0, (details.maxFoods || 30) - countMustHave);
            
            const uniqueFoodsVars = binaries.map(name => ({ name, coef: 1 }));
            if (uniqueFoodsVars.length > 0) {
                constraints.push({
                    name: 'unique_foods_count_limit',
                    vars: uniqueFoodsVars,
                    bnds: { type: glp.GLP_DB, lb: minNonMustHave, ub: maxNonMustHave }
                });
            }
        }

        // --- 3. MICRONUTRIENTS (Priority 2: Penalize Uncovered) ---
        essentialKeys.forEach((k: string) => {
            const config = nutrientConfig[k];
            const target = config.target || 1;
            const foodCoeffs = foods.map((f, i) => ({ name: `f_${i}`, coef: getNutrientValue(f, k) / target }));
            
            vars.push({ name: `unmet_${k}`, lb: 0, ub: 1, type: glp.GLP_DB });
            objectiveVars.push({ name: `unmet_${k}`, coef: 10000 }); 
            
            constraints.push({ 
                name: `mic_${k}`, 
                vars: [...foodCoeffs, { name: `unmet_${k}`, coef: 1 }], 
                bnds: { type: glp.GLP_LO, lb: 1, ub: 0 } 
            });

            if (config.max) {
                const maxRel = config.max / target;
                vars.push({ name: `over_${k}`, lb: 0, ub: 1000, type: glp.GLP_DB });
                objectiveVars.push({ name: `over_${k}`, coef: 100000 }); 
                constraints.push({ 
                    name: `mic_max_${k}`, 
                    vars: [...foodCoeffs, { name: `over_${k}`, coef: -1 }], 
                    bnds: { type: glp.GLP_UP, lb: 0, ub: maxRel } 
                });
            }

            if (config.optimalMin && config.optimalMax) {
                const optMinRel = config.optimalMin / target;
                const optMaxRel = config.optimalMax / target;
                
                vars.push({ name: `opt_min_${k}`, lb: 0, ub: 1000, type: glp.GLP_DB });
                vars.push({ name: `opt_max_${k}`, lb: 0, ub: 1000, type: glp.GLP_DB });
                
                // Mild penalty to pull values into the sweet spot range
                objectiveVars.push({ name: `opt_min_${k}`, coef: 1000 }); 
                objectiveVars.push({ name: `opt_max_${k}`, coef: 1000 }); 
                
                constraints.push({
                    name: `mic_opt_min_${k}`,
                    vars: [...foodCoeffs, { name: `opt_min_${k}`, coef: 1 }],
                    bnds: { type: glp.GLP_LO, lb: optMinRel, ub: 0 }
                });

                constraints.push({
                    name: `mic_opt_max_${k}`,
                    vars: [...foodCoeffs, { name: `opt_max_${k}`, coef: -1 }],
                    bnds: { type: glp.GLP_UP, lb: 0, ub: optMaxRel }
                });
            }
        });

        return await glp.solve({ 
            name: 'DietPlanner', 
            objective: { direction: glp.GLP_MIN, name: 'obj', vars: objectiveVars }, 
            subjectTo: constraints, 
            bounds: vars, 
            binaries: binaries 
        }, { 
            presol: true, 
            tmlim: timeLimit, 
            msglev: glp.GLP_MSG_ERR,
            meth: glp.GLP_DUAL,
            mipgap: 0.03 // Terminate early if we get within 3% of the theoretical optimum
        });
    } catch (err: any) { 
        return { result: { status: 0 } }; 
    }
}

async function run() {
    try {
        const startTime = Date.now();
        const uniqueFoodNames = new Set([...details.likedFoods, ...(details.mustHaveFoods || []).map((m:any)=>m.name)]);
        const likedPool = FOOD_DATABASE.filter((f: Food) => uniqueFoodNames.has(f.name)).sort((a,b)=>b.protein - a.protein);

        log(`Generating optimized diet from ${likedPool.length} foods...`);
        let candidates: any[] = [];
        
        // Trial 1: Full pool (Essential for strict personas)
        let fullRes = await solveGLPK(likedPool, true, 50, 1.0);
        
        // If Trial 1 failed or has high macro error, try a "Deep Deficit / High Protein" feasibility fallback
        const checkError = (res: any) => {
            if (!res.result || res.result.status === 0) return true;
            const totals = getTotalsFromVars(res.result.vars, likedPool);
            return Math.abs(totals.protein - proteinTarget) > 10;
        };

        if (checkError(fullRes)) {
            log("Initial attempt missed macro targets. Retrying with feasibility headroom...");
            // Use 100.0x headroom for Trial 1 fallback to guarantee protein hits for restrictive personas
            // This headroom is ONLY used if the standard trial fails to hit macro targets.
            fullRes = await solveGLPK(likedPool, true, 60, 100.0); 
        }

        if (fullRes.result && (fullRes.result.status === 5 || fullRes.result.status === 2)) {
            const totals = getTotalsFromVars(fullRes.result.vars, likedPool);
            const genome: any = {};
            likedPool.forEach((f, idx) => { 
                const v = fullRes.result.vars[`f_${idx}`]; 
                if (v > 0.001) genome[f.name] = Math.round(v * 100); 
            });
            candidates.push({ genome, totals, mScore: calculateMacroScore(totals), nScore: calculateNutrientScore(totals) });
        }

        // Post baseline progress
        parentPort?.postMessage({
            type: 'progress',
            gen: 6,
            accuracy: candidates.length > 0 ? Math.round((candidates[0].nScore / (essentialKeys.length || 1)) * 100) : 0,
            telemetry: {
                trialInfo: `Completed full-pool baseline trial`
            }
        });

        // Subsequent trials: Randomized subsets (Variety)
        for (let i = 1; i < 15; i++) {
            // Check if elapsed time has exceeded our time budget of 80 seconds
            const elapsed = (Date.now() - startTime) / 1000;
            if (elapsed > 80) {
                log(`Stopping subsequent trials early (elapsed: ${elapsed.toFixed(1)}s) to respect time budget.`);
                break;
            }

            const subsetSize = Math.min(likedPool.length, 60);
            const subset = [...likedPool].sort(() => 0.5 - Math.random()).slice(0, subsetSize);
            const res = await solveGLPK(subset, true, 3);
            if (res.result && (res.result.status === 5 || res.result.status === 2)) {
                const totals = getTotalsFromVars(res.result.vars, subset);
                const genome: any = {};
                subset.forEach((f, idx) => { 
                    const v = res.result.vars[`f_${idx}`]; 
                    if (v > 0.001) genome[f.name] = Math.round(v * 100); 
                });
                candidates.push({ 
                    genome, 
                    totals, 
                    mScore: calculateMacroScore(totals),
                    nScore: calculateNutrientScore(totals) 
                });
            }

            // Post incremental progress
            const progressPct = Math.round(((i + 1) / 16) * 100);
            parentPort?.postMessage({
                type: 'progress',
                gen: progressPct,
                accuracy: candidates.length > 0 ? Math.round((candidates[0].nScore / (essentialKeys.length || 1)) * 100) : 0,
                telemetry: {
                    trialInfo: `Completed trial ${i}/15 (${candidates.length} candidates found)`
                }
            });
        }

        if (candidates.length > 0) {
            // Priority 1: Macro/Calorie Accuracy (Within 1g/kcal error)
            // Priority 2: Micronutrient Score
            candidates.sort((a,b) => {
                const aM = a.mScore;
                const bM = b.mScore;
                
                // If either is significantly better at macros, take it
                if (Math.abs(aM - bM) > 15.0) return bM - aM; 
                
                // Otherwise tie-break with nutrients
                return b.nScore - a.nScore;
            });
            const best = candidates[0];
            log(`Selected best candidate with mScore: ${best.mScore.toFixed(2)} and nScore: ${best.nScore.toFixed(2)}`);
            parentPort?.postMessage({ 
                type: 'result', 
                result: { 
                    genome: best.genome, 
                    targetCalories, 
                    actualCalories: Math.round(best.totals.energy), 
                    accuracy: Math.round((best.nScore/essentialKeys.length)*1000)/10, 
                    macros: { 
                        protein: Math.round(best.totals.protein), 
                        carbs: Math.round(best.totals.carbs), 
                        fat: Math.round(best.totals.fat) 
                    },
                    micronutrients: best.totals
                } 
            });
        } else {
            parentPort?.postMessage({ type: 'result', result: null, error: "Mathematical solver failed." });
        }
    } catch (err: any) { parentPort?.postMessage({ type: 'result', result: null, error: "System Error: " + err.message }); }
}
run();
