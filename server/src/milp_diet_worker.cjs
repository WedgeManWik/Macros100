const { parentPort, workerData } = require('worker_threads');
const solver = require('javascript-lp-solver');

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const foodMap = new Map();
FOOD_DATABASE.forEach((f) => foodMap.set(f.name, f));

/**
 * NEW ALGORITHM GOALS:
 * 1. Calories: target <= C <= target + 50. (Harder priority)
 * 2. Macros: P, C, F targets with wiggle room.
 * 3. Nutrients: Maximize MINIMUM coverage (Balanced Coverage).
 * 4. Nutrients: Maximize TOTAL coverage (up to 100%).
 */

function buildModel(foods, useBinaries) {
    const model = {
        optimize: "score",
        opType: "max",
        constraints: {},
        variables: {},
        options: { timeout: 30000 } // 30 seconds
    };

    if (useBinaries) model.binaries = {};

    // --- CALORIE CONSTRAINTS ---
    model.constraints.cal_sum = { min: targetCalories, max: targetCalories + 50 };
    model.variables.cal_deficit = { score: -1000000000000, cal_sum: 1 };

    // --- MACRO CONSTRAINTS ---
    ['protein', 'fat', 'carbs'].forEach(m => {
        const target = (m === 'protein' ? proteinTarget : (m === 'fat' ? fatTarget : carbTarget));
        const wiggle = (m === 'fat' ? 2 : 5);
        model.constraints[`macro_${m}_sum`] = { min: target - wiggle, max: target + wiggle };
        model.variables[`${m}_def`] = { score: -1000000000, [`macro_${m}_sum`]: 1 };
        model.variables[`${m}_ex`] = { score: -1000000000, [`macro_${m}_sum`]: -1 };
    });

    // --- NUTRIENT CONSTRAINTS (BALANCED COVERAGE) ---
    model.variables.min_coverage = { score: 1000000 }; 
    
    essentialKeys.forEach((k) => {
        const config = nutrientConfig[k];
        if (!config || config.target <= 0) return;

        const covVar = `cov_${k}`;
        model.variables[covVar] = { 
            score: 1000, 
            [`track_cov_${k}`]: -1,
            [`limit_cov_${k}`]: 1,
            [`balanced_min`]: 1 
        };
        model.constraints[`limit_cov_${k}`] = { max: 1.0 };
        model.constraints[`track_cov_${k}`] = { min: 0 };
        
        if (config.max) {
            model.constraints[`track_max_${k}`] = { max: config.max };
        }
    });

    essentialKeys.forEach((k) => {
        if (!nutrientConfig[k] || nutrientConfig[k].target <= 0) return;
        const constraintName = `min_link_${k}`;
        model.constraints[constraintName] = { max: 0 };
        model.variables.min_coverage[constraintName] = 1;
        model.variables[`cov_${k}`][constraintName] = -1;
    });

    // --- FOOD VARIABLES ---
    foods.forEach((f, idx) => {
        const varName = `f_${idx}`;
        const foodVar = {
            score: -0.1,
            cal_sum: f.calories,
            macro_protein_sum: f.protein,
            macro_fat_sum: f.fat,
            macro_carbs_sum: f.carbs
        };

        essentialKeys.forEach((k) => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] || 0));
            if (nutrientConfig[k] && nutrientConfig[k].target > 0) {
                foodVar[`track_cov_${k}`] = val / nutrientConfig[k].target;
            }
            if (nutrientConfig[k] && nutrientConfig[k].max) {
                foodVar[`track_max_${k}`] = val;
            }
        });

        const mustHave = details.mustHaveFoods ? details.mustHaveFoods.find((m) => m.name === f.name) : null;
        const minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
        let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : 
                  ((details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? (details.customMaxAmounts[f.name] / 100) : (f.maxAmount / 100));
        
        if (maxVal < minVal) maxVal = minVal;

        if (useBinaries) {
            const binName = `u_${idx}`;
            model.binaries[binName] = 1;
            const minConstraint = `min_bound_${idx}`;
            const maxConstraint = `max_bound_${idx}`;
            model.constraints[minConstraint] = { min: 0 };
            model.constraints[maxConstraint] = { max: 0 };
            foodVar[minConstraint] = 1;
            foodVar[maxConstraint] = 1;
            model.variables[binName] = { [minConstraint]: -minVal, [maxConstraint]: -maxVal };

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

function evaluateDiet(genome) {
    const totals = { energy: 0, protein: 0, carbs: 0, fat: 0 };
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
                if (totals[n] !== undefined) totals[n] += r * (f.nutrients[n] || 0);
            }
        }
    }

    let metCount = 0;
    essentialKeys.forEach((k) => {
        const pct = totals[k] / (nutrientConfig[k].target || 1);
        if (pct >= 0.95) metCount++;
    });

    const accuracy = Math.round((metCount / essentialKeys.length) * 1000) / 10;
    return { accuracy, totals, genome };
}

function run() {
    const totalTimeout = setTimeout(() => {
        parentPort.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, 60000);

    try {
        const likedFoods = details.likedFoods || [];
        const mustHaveNames = new Set((details.mustHaveFoods || []).map(m => m.name));

        let allowed = FOOD_DATABASE.filter((f) => {
            if (mustHaveNames.has(f.name)) return true;
            if (likedFoods.length === 0) return true;
            const nameLower = f.name.toLowerCase();
            return likedFoods.some(l => {
                const lLower = l.toLowerCase();
                if (nameLower === lLower) return true;
                const escapedL = lLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedL}\\b`, 'i');
                return regex.test(nameLower);
            });
        });

        if (allowed.length === 0 && likedFoods.length === 0) allowed = [...FOOD_DATABASE];

        if (allowed.length > 60) {
            const selectedSet = new Set();
            allowed.forEach(f => { if (mustHaveNames.has(f.name)) selectedSet.add(f.name); });
            essentialKeys.forEach((k) => {
                const sortedForK = [...allowed].sort((a, b) => {
                    const valA = (k === 'energy' ? a.calories : k === 'protein' ? a.protein : k === 'carbs' ? a.carbs : k === 'fat' ? a.fat : (a.nutrients[k] || 0));
                    const valB = (k === 'energy' ? b.calories : k === 'protein' ? b.protein : k === 'carbs' ? b.carbs : k === 'fat' ? b.fat : (b.nutrients[k] || 0));
                    return (valB / (b.calories||1)) - (valA / (a.calories||1));
                });
                if (sortedForK[0]) selectedSet.add(sortedForK[0].name);
                if (sortedForK[1]) selectedSet.add(sortedForK[1].name);
            });
            const scored = allowed.map(f => {
                let density = 0;
                essentialKeys.forEach(k => {
                    const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] || 0));
                    density += Math.min(1.0, (val / (nutrientConfig[k].target||1)) / (f.calories / 100 || 1));
                });
                return { f, score: density };
            });
            scored.sort((a, b) => b.score - a.score);
            for (let i = 0; i < scored.length && selectedSet.size < 60; i++) selectedSet.add(scored[i].f.name);
            allowed = FOOD_DATABASE.filter(f => selectedSet.has(f.name));
        }

        parentPort.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: "Formulating MILP Model..." } });
        const lpResults = solver.Solve(buildModel(allowed, false));
        let bestGenome = {};
        if (lpResults.feasible) {
            allowed.forEach((f, idx) => {
                const amt = lpResults[`f_${idx}`] || 0;
                if (amt > 0.001) bestGenome[f.name] = Math.round(amt * 100);
            });
        }

        const promisingFoods = allowed.filter((f, idx) => (lpResults[`f_${idx}`] > 0.001) || mustHaveNames.has(f.name)).slice(0, 35);
        parentPort.postMessage({ type: 'progress', gen: 50, accuracy: 0, telemetry: { trialInfo: `Solving MILP with ${promisingFoods.length} foods...` } });
        const milpResults = solver.Solve(buildModel(promisingFoods, true));
        if (milpResults.feasible && milpResults.result) {
            const milpGenome = {};
            promisingFoods.forEach((f, idx) => {
                const amt = milpResults[`f_${idx}`] || 0;
                if (amt > 0.001) milpGenome[f.name] = Math.round(amt * 100);
            });
            bestGenome = milpGenome;
        }

        const finalEvaluation = evaluateDiet(bestGenome);
        clearTimeout(totalTimeout);
        parentPort.postMessage({ 
            type: 'result', 
            result: {
                genome: finalEvaluation.genome,
                targetCalories,
                actualCalories: Math.round(finalEvaluation.totals.energy),
                accuracy: finalEvaluation.accuracy,
                macros: { protein: Math.round(finalEvaluation.totals.protein), carbs: Math.round(finalEvaluation.totals.carbs), fat: Math.round(finalEvaluation.totals.fat) }
            }
        });
    } catch (err) {
        clearTimeout(totalTimeout);
        console.error("FATAL: " + err.stack);
        parentPort.postMessage({ type: 'result', result: null });
    }
}

run();
