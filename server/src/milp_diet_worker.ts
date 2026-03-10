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

/**
 * NEW ALGORITHM GOALS:
 * 1. Calories: target <= C <= target + 50. (Harder priority)
 * 2. Macros: P, C, F targets with wiggle room.
 * 3. Nutrients: Maximize MINIMUM coverage (Balanced Coverage).
 * 4. Nutrients: Maximize TOTAL coverage (up to 100%).
 */

function buildModel(foods: Food[], useBinaries: boolean) {
    const model: any = {
        optimize: "score",
        opType: "max",
        constraints: {},
        variables: {},
        options: { timeout: 30000 } // 30 seconds
    };

    if (useBinaries) model.binaries = {};

    // --- CALORIE CONSTRAINTS ---
    // We want Calories >= target and Calories <= target + 50
    // To be robust, we'll use a huge penalty for going below target
    model.constraints.cal_sum = { min: targetCalories, max: targetCalories + 50 };
    
    // Slack for calorie deficit (in case target is unreachable with min amounts)
    // Penalty is extremely high to prioritize calories above all else
    model.variables.cal_deficit = { score: -1000000000000, cal_sum: 1 };

    // --- MACRO CONSTRAINTS ---
    // User wants "some wiggle room". Let's use +/- 5g for P/C and +/- 2g for Fat
    // We'll use penalties for macro deviation
    ['protein', 'fat', 'carbs'].forEach(m => {
        const target = (m === 'protein' ? proteinTarget : (m === 'fat' ? fatTarget : carbTarget));
        const wiggle = (m === 'fat' ? 2 : 5);
        
        model.constraints[`macro_${m}_sum`] = { min: target - wiggle, max: target + wiggle };
        
        // Slack variables for macro deviation with high penalties (but lower than calories)
        model.variables[`${m}_def`] = { score: -1000000000, [`macro_${m}_sum`]: 1 };
        model.variables[`${m}_ex`] = { score: -1000000000, [`macro_${m}_sum`]: -1 };
    });

    // --- NUTRIENT CONSTRAINTS (BALANCED COVERAGE) ---
    // 1. Variable: min_coverage
    // 2. Constraint: min_coverage <= coverage_k for all k
    // 3. Variable: total_coverage = sum(min(1.0, coverage_k))
    
    // We use a high reward for min_coverage to prioritize balance
    model.variables.min_coverage = { score: 1000000 }; 
    
    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        if (!config || config.target <= 0) return;

        // Variable for clamped coverage (0 to 1.0)
        // This variable is used to maximize total coverage once minimum is pushed up
        const covVar = `cov_${k}`;
        model.variables[covVar] = { 
            score: 1000, // Secondary reward for total coverage
            [`track_cov_${k}`]: -1,
            [`limit_cov_${k}`]: 1,
            [`balanced_min`]: 1 // min_coverage <= cov_k
        };
        model.constraints[`limit_cov_${k}`] = { max: 1.0 };
        model.constraints[`track_cov_${k}`] = { min: 0 };
        
        // Add hard constraint for max limit if defined
        if (config.max) {
            model.constraints[`track_max_${k}`] = { max: config.max };
        }
        
        // balanced_min constraint: min_coverage - cov_k <= 0  => min_coverage <= cov_k
        // However, we need to apply min_coverage to the variable, not the food sum directly
        // to ensure it's capped at 1.0 if we want min_coverage to be meaningful.
        // Actually, min_coverage should be <= cov_k, and cov_k <= track_cov_k.
        // Since we maximize min_coverage, it will push all cov_k up.
    });

    // Linking min_coverage to all cov_k
    // min_coverage <= cov_k  => min_coverage - cov_k <= 0
    essentialKeys.forEach((k: string) => {
        if (nutrientConfig[k].target <= 0) return;
        const constraintName = `min_link_${k}`;
        model.constraints[constraintName] = { max: 0 };
        model.variables.min_coverage[constraintName] = 1;
        model.variables[`cov_${k}`][constraintName] = -1;
    });

    // --- FOOD VARIABLES ---
    foods.forEach((f: Food, idx: number) => {
        const varName = `f_${idx}`;
        const foodVar: any = {
            score: -0.1, // Tiny penalty for amount to prefer simpler diets if tied
            cal_sum: f.calories,
            macro_protein_sum: f.protein,
            macro_fat_sum: f.fat,
            macro_carbs_sum: f.carbs
        };

        essentialKeys.forEach((k: string) => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
            if (nutrientConfig[k].target > 0) {
                foodVar[`track_cov_${k}`] = val / nutrientConfig[k].target;
            }
        });

        // Min/Max Quantities
        const mustHave = details.mustHaveFoods ? details.mustHaveFoods.find((m: any) => m.name === f.name) : null;
        const minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
        let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : 
                  ((details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? (details.customMaxAmounts[f.name] / 100) : (f.maxAmount / 100));
        
        if (maxVal < minVal) maxVal = minVal;

        if (useBinaries) {
            const binName = `u_${idx}`;
            model.binaries[binName] = 1;
            
            // If binName is 1, then f_idx must be between [minVal, maxVal]
            // If binName is 0, then f_idx must be 0
            
            // Standard MILP trick for variable with min/max or zero:
            // f_idx >= minVal * binName
            // f_idx <= maxVal * binName
            
            const minConstraint = `min_bound_${idx}`;
            const maxConstraint = `max_bound_${idx}`;
            
            model.constraints[minConstraint] = { min: 0 };
            model.constraints[maxConstraint] = { max: 0 };
            
            foodVar[minConstraint] = 1;
            foodVar[maxConstraint] = 1;
            
            model.variables[binName] = {
                [minConstraint]: -minVal,
                [maxConstraint]: -maxVal
            };

            if (mustHave) {
                model.constraints[`force_${idx}`] = { equal: 1 };
                model.variables[binName][`force_${idx}`] = 1;
            }
        } else {
            model.constraints[`limit_${idx}`] = { min: 0, max: maxVal };
            foodVar[`limit_${idx}`] = 1;
        }
        
        model.variables[varName] = foodVar;
    });

    return model;
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
        if (f.nutrients) {
            for (const n in f.nutrients) {
                if (totals[n] !== undefined) totals[n] += r * (f.nutrients as any)[n];
            }
        }
    }

    let metCount = 0;
    let totalRdaPct = 0;
    essentialKeys.forEach((k: string) => {
        const pct = totals[k] / (nutrientConfig[k].target || 1);
        totalRdaPct += Math.min(1.0, pct);
        if (pct >= 0.95) metCount++;
    });

    const accuracy = Math.round((metCount / essentialKeys.length) * 1000) / 10;
    
    return {
        accuracy,
        totals,
        genome
    };
}

function run() {
    const totalTimeout = setTimeout(() => {
        console.error("Worker Global Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, 60000);

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
                const regex = new RegExp(`\\b${escapedL}\\b`, 'i');
                return regex.test(nameLower);
            });
        });

        if (allowed.length === 0 && likedFoods.length === 0) allowed = [...FOOD_DATABASE];

        // Selection logic for better performance if too many foods
        // We increase limit to 60 as our model is more streamlined
        if (allowed.length > 60) {
            const selectedSet = new Set<string>();
            allowed.forEach((f: Food) => { if (mustHaveNames.has(f.name)) selectedSet.add(f.name); });
            
            // Always pick top 2 foods per essential nutrient
            essentialKeys.forEach((k: string) => {
                const sortedForK = [...allowed].sort((a, b) => {
                    const valA = (k === 'energy' ? a.calories : k === 'protein' ? a.protein : k === 'carbs' ? a.carbs : k === 'fat' ? a.fat : (a.nutrients[k] as any || 0));
                    const valB = (k === 'energy' ? b.calories : k === 'protein' ? b.protein : k === 'carbs' ? b.carbs : k === 'fat' ? b.fat : (b.nutrients[k] as any || 0));
                    return (valB / (b.calories||1)) - (valA / (a.calories||1));
                });
                if (sortedForK[0]) selectedSet.add(sortedForK[0].name);
                if (sortedForK[1]) selectedSet.add(sortedForK[1].name);
            });

            // Fill remainder with overall nutrient dense foods
            const scored = allowed.map((f: Food) => {
                let density = 0;
                essentialKeys.forEach((k: string) => {
                    const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
                    density += Math.min(1.0, (val / (nutrientConfig[k].target||1)) / (f.calories / 100 || 1));
                });
                return { f, score: density };
            });
            scored.sort((a: any, b: any) => b.score - a.score);
            for (let i = 0; i < scored.length && selectedSet.size < 60; i++) selectedSet.add(scored[i].f.name);
            allowed = FOOD_DATABASE.filter((f: Food) => selectedSet.has(f.name));
        }

        parentPort?.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: "Formulating MILP Model..." } });

        // First pass: Solve without binaries for speed and to check feasibility
        const lpResults = solver.Solve(buildModel(allowed, false));
        
        let bestGenome: Record<string, number> = {};
        if (lpResults.feasible) {
            allowed.forEach((f: Food, idx: number) => {
                const amt = lpResults[`f_${idx}`] || 0;
                if (amt > 0.001) bestGenome[f.name] = Math.round(amt * 100);
            });
        }

        // Second pass: Use binaries on a subset of promising foods for discrete amounts
        // We pick top ~30 foods from LP result
        const promisingFoods = allowed.filter((f: Food, idx: number) => (lpResults[`f_${idx}`] > 0.001) || mustHaveNames.has(f.name))
                                    .slice(0, 35);
        
        parentPort?.postMessage({ type: 'progress', gen: 50, accuracy: 0, telemetry: { trialInfo: `Solving MILP with ${promisingFoods.length} foods...` } });
        
        const milpResults = solver.Solve(buildModel(promisingFoods, true));
        
        if (milpResults.feasible && milpResults.result) {
            const milpGenome: Record<string, number> = {};
            promisingFoods.forEach((f: Food, idx: number) => {
                const amt = milpResults[`f_${idx}`] || 0;
                if (amt > 0.001) milpGenome[f.name] = Math.round(amt * 100);
            });
            bestGenome = milpGenome;
        }

        const finalEvaluation = evaluateDiet(bestGenome);

        clearTimeout(totalTimeout);
        parentPort?.postMessage({ 
            type: 'result', 
            result: {
                genome: finalEvaluation.genome,
                targetCalories,
                actualCalories: Math.round(finalEvaluation.totals.energy),
                accuracy: finalEvaluation.accuracy,
                macros: { 
                    protein: Math.round(finalEvaluation.totals.protein), 
                    carbs: Math.round(finalEvaluation.totals.carbs), 
                    fat: Math.round(finalEvaluation.totals.fat) 
                }
            }
        });

    } catch (err: any) {
        clearTimeout(totalTimeout);
        console.error("FATAL: " + err.stack);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
