const { parentPort, workerData } = require('worker_threads');
const solver = require('javascript-lp-solver');

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const foodMap = new Map();
FOOD_DATABASE.forEach((f) => foodMap.set(f.name, f));

function buildModel(foods, useBinaries, priorities) {
    const model = {
        optimize: "score",
        opType: "max",
        constraints: {},
        variables: {},
        options: { timeout: priorities.timeout || 10000 }
    };

    if (useBinaries) model.binaries = {};

    // --- HARD CALORIE BOUNDARY (+/- 100) ---
    model.constraints.bal_energy = { min: targetCalories - 100, max: targetCalories + 100 };
    
    // Slacks for calories within the hard range
    model.variables.en_def = { score: -1000, bal_energy: 1 };
    model.variables.en_ex = { score: -1000, bal_energy: -1 };

    const MACRO_PENALTY = priorities.macroPenalty;
    const NUTRIENT_REWARD = priorities.nutrientReward;

    ['protein', 'fat', 'carbs'].forEach(m => {
        const target = (m === 'protein' ? proteinTarget : (m === 'fat' ? fatTarget : carbTarget));
        model.constraints[`bal_${m}`] = { equal: target };
        model.variables[`${m}_def`] = { score: -MACRO_PENALTY, [`bal_${m}`]: 1 };
        model.variables[`${m}_ex`] = { score: -MACRO_PENALTY, [`bal_${m}`]: -1 };
    });

    essentialKeys.forEach(k => {
        const config = nutrientConfig[k];
        if (config.target <= 0) return;
        model.variables[`cov_${k}`] = { score: NUTRIENT_REWARD, [`lim_cov_${k}`]: 1, [`track_cov_${k}`]: -1 };
        model.constraints[`lim_cov_${k}`] = { max: 1.0 };
        model.constraints[`track_cov_${k}`] = { min: 0 };
        if (config.max) {
            model.variables[`over_${k}`] = { score: -NUTRIENT_REWARD * 10, [`track_max_${k}`]: -1 };
            model.constraints[`track_max_${k}`] = { max: config.max };
        }
    });

    foods.forEach((f, idx) => {
        const varName = `f_${idx}`;
        const foodVar = {
            score: -0.0001,
            bal_energy: f.calories,
            bal_protein: f.protein,
            bal_fat: f.fat,
            bal_carbs: f.carbs
        };
        essentialKeys.forEach(k => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] || 0));
            if (nutrientConfig[k].essential && nutrientConfig[k].target > 0) {
                foodVar[`track_cov_${k}`] = val / nutrientConfig[k].target;
            }
            if (nutrientConfig[k].max) foodVar[`track_max_${k}`] = val;
        });

        const mustHave = details.mustHaveFoods ? details.mustHaveFoods.find((m) => m.name === f.name) : null;
        const minVal = (mustHave ? (mustHave.min || f.minAmount || 0) : (f.minAmount || 0)) / 100;
        let maxVal = (mustHave && mustHave.max !== undefined) ? (mustHave.max / 100) : 
                  ((details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? (details.customMaxAmounts[f.name] / 100) : (f.maxAmount / 100));
        if (maxVal < minVal) maxVal = minVal;

        if (useBinaries) {
            const binName = `u_${idx}`;
            model.binaries[binName] = 1;
            model.constraints[`min_b_${idx}`] = { min: 0 };
            model.constraints[`max_b_${idx}`] = { max: 0 };
            foodVar[`min_b_${idx}`] = 1;
            foodVar[`max_b_${idx}`] = 1;
            model.variables[binName] = { [`min_b_${idx}`]: -minVal, [`max_b_${idx}`]: -maxVal };
            if (mustHave) {
                model.constraints[`force_${idx}`] = { equal: 1 };
                model.variables[binName][`force_${idx}`] = 1;
            }
        } else {
            model.constraints[`lim_${idx}`] = { min: 0, max: maxVal };
            foodVar[`lim_${idx}`] = 1;
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
            for (const n in f.nutrients) { if (totals[n] !== undefined) totals[n] += r * (f.nutrients[n] || 0); }
        }
    }

    let metCount = 0;
    let totalRdaPct = 0;
    essentialKeys.forEach(k => {
        const pct = totals[k] / (nutrientConfig[k].target || 1);
        totalRdaPct += Math.min(1.0, pct);
        if (pct >= 0.95) metCount++;
    });

    const avgRdaPct = totalRdaPct / essentialKeys.length;
    const calDiff = Math.abs(totals.energy - targetCalories);
    const macroDiff = Math.abs(totals.protein - proteinTarget) + Math.abs(totals.fat - fatTarget) + Math.abs(totals.carbs - carbTarget);
    
    // Final score: Nutrients minus penalties for Calories and Macros
    const score = (avgRdaPct * 100) - (calDiff / 5) - (macroDiff * 5);
    
    return {
        score,
        accuracy: Math.round((metCount / essentialKeys.length) * 1000) / 10,
        totals,
        genome
    };
}

function run() {
    const totalTimeout = setTimeout(() => {
        console.error("Worker Global Safety Timeout Triggered!");
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

        if (allowed.length > 40) {
            const selectedSet = new Set();
            allowed.forEach(f => { if (mustHaveNames.has(f.name)) selectedSet.add(f.name); });
            ['protein', 'fat', 'carbs'].forEach((m) => {
                const sortedByMacro = [...allowed].sort((a, b) => (b[m] / b.calories) - (a[m] / a.calories));
                for (let i = 0; i < 5; i++) if (sortedByMacro[i]) selectedSet.add(sortedByMacro[i].name);
            });
            essentialKeys.forEach(k => {
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
            for (let i = 0; i < scored.length && selectedSet.size < 40; i++) selectedSet.add(scored[i].f.name);
            allowed = FOOD_DATABASE.filter(f => selectedSet.has(f.name));
        }

        const rdaPriorities = { calDefPenalty: 100000, calExPenalty: 1000, macroPenalty: 10, nutrientReward: 10000000, timeout: 5000 };
        const resNutrient = solver.Solve(buildModel(allowed, false, rdaPriorities));
        const poolNutrient = allowed.filter((f, idx) => resNutrient[`f_${idx}`] > 0.01 || mustHaveNames.has(f.name)).slice(0, 18);

        const macroPriorities = { calDefPenalty: 10000000, calExPenalty: 1000000, macroPenalty: 10000000, nutrientReward: 10, timeout: 5000 };
        const resMacro = solver.Solve(buildModel(allowed, false, macroPriorities));
        const poolMacro = allowed.filter((f, idx) => resMacro[`f_${idx}`] > 0.01 || mustHaveNames.has(f.name)).slice(0, 18);

        let globalBest = null;
        const totalIterations = 25; // REDUCED for speed (approx 5-8 seconds total runtime)

        for (let i = 0; i < totalIterations; i++) {
            const ratio = i / (totalIterations - 1);
            const gen = Math.round((i / totalIterations) * 24000);
            if (i % 2 === 0) parentPort.postMessage({ type: 'progress', gen: gen, accuracy: globalBest ? globalBest.accuracy : 0, telemetry: { trialInfo: `Optimizing: ${Math.round(ratio*100)}%` } });

            const priorities = {
                calDefPenalty: 100000 * (1 - ratio) + 100000000 * ratio,
                calExPenalty: 1000 * (1 - ratio) + 10000000 * ratio,
                macroPenalty: 10 * (1 - ratio) + 10000000 * ratio,
                nutrientReward: 10000000 * (1 - ratio) + 100000 * ratio,
                timeout: 300 
            };

            const fullPool = ratio < 0.5 ? poolNutrient : poolMacro;
            let milpLimit = Math.min(fullPool.length, 25);
            
            while (milpLimit >= 12) {
                const subset = fullPool.slice(0, milpLimit);
                const results = solver.Solve(buildModel(subset, true, priorities));
                
                if (results.feasible && results.result && !results.timeout) {
                    const genome = {};
                    subset.forEach((f, idx) => { genome[f.name] = Math.round((results[`f_${idx}`] || 0) * 100); });
                    const evaluated = evaluateDiet(genome);
                    if (!globalBest || evaluated.score > globalBest.score) globalBest = evaluated;
                    break; 
                }
                milpLimit -= 2; 
            }
        }

        if (!globalBest) {
            const genome = {};
            allowed.forEach((f, idx) => { genome[f.name] = Math.round((resNutrient[`f_${idx}`] || 0) * 100); });
            globalBest = evaluateDiet(genome);
        }

        clearTimeout(totalTimeout);
        parentPort.postMessage({ 
            type: 'result', 
            result: {
                genome: globalBest.genome,
                targetCalories,
                actualCalories: Math.round(globalBest.totals.energy),
                accuracy: globalBest.accuracy,
                macros: { protein: Math.round(globalBest.totals.protein), carbs: Math.round(globalBest.totals.carbs), fat: Math.round(globalBest.totals.fat) }
            }
        });

    } catch (err) {
        clearTimeout(totalTimeout);
        console.error("FATAL: " + err.stack);
        parentPort.postMessage({ type: 'result', result: null });
    }
}

run();
