const { parentPort, workerData } = require('worker_threads');
const solver = require('javascript-lp-solver');

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const foodMap = new Map();
FOOD_DATABASE.forEach((f) => foodMap.set(f.name, f));

function buildModel(foods, useBinaries) {
    const model = {
        optimize: "score",
        opType: "max",
        constraints: {},
        variables: {},
        options: { timeout: 10000 }
    };

    if (useBinaries) model.binaries = {};

    const nutrientReward = 100000;

    // Soft Macro Constraints
    model.constraints.bal_energy = { equal: targetCalories };
    model.variables.en_def = { score: -1000, bal_energy: 1 };
    model.variables.en_ex = { score: -1000, bal_energy: -1 };
    
    // 70kcal Free Zone
    model.variables.en_free_def = { score: 1000, bal_energy: 1, lim_en_free_def: 1 };
    model.constraints.lim_en_free_def = { max: 70 };
    model.variables.en_free_ex = { score: 1000, bal_energy: -1, lim_en_free_ex: 1 };
    model.constraints.lim_en_free_ex = { max: 70 };

    ['protein', 'fat', 'carbs'].forEach(m => {
        const target = (m === 'protein' ? proteinTarget : (m === 'fat' ? fatTarget : carbTarget));
        model.constraints[`bal_${m}`] = { equal: target };
        model.variables[`${m}_def`] = { score: -500, [`bal_${m}`]: 1 };
        model.variables[`${m}_ex`] = { score: -500, [`bal_${m}`]: -1 };
    });

    // Soft Nutrient Constraints
    essentialKeys.forEach(k => {
        const config = nutrientConfig[k];
        if (config.target <= 0) return;
        model.variables[`cov_${k}`] = { score: nutrientReward, [`lim_cov_${k}`]: 1, [`track_cov_${k}`]: -1 };
        model.constraints[`lim_cov_${k}`] = { max: 1.0 };
        model.constraints[`track_cov_${k}`] = { min: 0 };
        if (config.max) {
            model.variables[`over_${k}`] = { score: -nutrientReward * 10, [`track_max_${k}`]: -1 };
            model.constraints[`track_max_${k}`] = { max: config.max };
        }
    });

    // Foods
    foods.forEach((f, idx) => {
        const varName = `f_${idx}`;
        const foodVar = {
            score: -0.1,
            bal_energy: f.calories,
            bal_protein: f.protein,
            bal_fat: f.fat,
            bal_carbs: f.carbs
        };

        Object.keys(nutrientConfig).forEach(k => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] || 0));
            if (nutrientConfig[k].essential && nutrientConfig[k].target > 0) {
                foodVar[`track_cov_${k}`] = val / nutrientConfig[k].target;
            }
            if (nutrientConfig[k].max) {
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
            // Phase 1: Simple LP, ignore minVal to keep it fast and guaranteed feasible
            model.constraints[`lim_${idx}`] = { max: maxVal };
            foodVar[`lim_${idx}`] = 1;
        }

        model.variables[varName] = foodVar;
    });

    return model;
}

function run() {
    // Safety exit after 20 seconds
    const timeout = setTimeout(() => {
        console.error("Worker Safety Timeout Triggered!");
        parentPort.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, 20000);

    try {
        const likedSet = details.likedFoods && details.likedFoods.length > 0 ? new Set(details.likedFoods) : null;
        const mustHaveNames = new Set((details.mustHaveFoods || []).map(m => m.name));

        let allowed = FOOD_DATABASE.filter((f) => {
            // If we have a liked list, only include foods in that list OR must-haves
            if (likedSet) {
                return likedSet.has(f.name) || mustHaveNames.has(f.name);
            }
            return true;
        });

        // If after filtering we have no foods, fallback to all foods
        if (allowed.length === 0) {
            console.log("No matched foods allowed, falling back to full database");
            allowed = [...FOOD_DATABASE];
        }

        // Even if we have a liked list, if it's large (>25), Phase 1 can still hang.
        // We MUST limit the complexity of the Phase 1 LP to ensure speed.
        if (allowed.length > 25) {
            console.log(`Phase 0: Scoring ${allowed.length} foods to pick top 25...`);
            const scored = allowed.map(f => {
                let nutrientDensity = 0;
                essentialKeys.forEach(k => {
                    const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] || 0));
                    const target = nutrientConfig[k].target;
                    if (target > 0) nutrientDensity += (val / target);
                });
                const score = nutrientDensity / (f.calories / 100 || 1);
                return { f, score };
            });

            scored.sort((a, b) => {
                if (isNaN(a.score)) return 1;
                if (isNaN(b.score)) return -1;
                return b.score - a.score;
            });
            
            const topFoods = scored.slice(0, 25).map(s => s.f);
            
            // Ensure must-haves are ALWAYS in the selection regardless of score
            const finalAllowed = [...topFoods];
            allowed.forEach(f => {
                if (mustHaveNames.has(f.name) && !finalAllowed.some(fa => fa.name === f.name)) {
                    finalAllowed.push(f);
                }
            });
            allowed = finalAllowed;
        }

        console.log(`Phase 1: Starting with ${allowed.length} allowed foods`);
        parentPort.postMessage({ type: 'progress', gen: 0, accuracy: 0, telemetry: { trialInfo: 'Phase 1: Selection' } });

        // Phase 1: Pure LP (No binaries, no min-bounds)
        const phase1Results = solver.Solve(buildModel(allowed, false));
        console.log("Phase 1: Solved");

        // Get Top 30 Foods
        const candidates = [];
        allowed.forEach((f, idx) => {
            const amount = phase1Results[`f_${idx}`] || 0;
            const mustHave = details.mustHaveFoods ? details.mustHaveFoods.find((m) => m.name === f.name) : null;
            if (amount > 0.001 || mustHave) candidates.push({ f, amount });
        });
        candidates.sort((a, b) => b.amount - a.amount);
        let usefulFoods = candidates.slice(0, 30).map(c => c.f);

        if (usefulFoods.length === 0) {
            console.log("No useful foods found in Phase 1, using fallback");
            usefulFoods = allowed.slice(0, 30);
        }

        parentPort.postMessage({ type: 'progress', gen: 1, accuracy: 50, telemetry: { trialInfo: 'Phase 2: Optimization' } });

        // Phase 2: MILP (Only 30 foods, with binaries and min-bounds)
        const results = solver.Solve(buildModel(usefulFoods, true));
        console.log("Phase 2: Solved");

        const genome = {};
        usefulFoods.forEach((f, idx) => {
            genome[f.name] = Math.round((results[`f_${idx}`] || 0) * 100);
        });

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

        let met = 0;
        essentialKeys.forEach(k => {
            if (totals[k] / (nutrientConfig[k].target || 1) >= 0.95) met++;
        });

        clearTimeout(timeout);
        parentPort.postMessage({ 
            type: 'result', 
            result: {
                genome,
                targetCalories,
                actualCalories: Math.round(totals.energy),
                accuracy: Math.round((met / essentialKeys.length) * 1000) / 10,
                macros: { protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat) }
            }
        });
    } catch (err) {
        clearTimeout(timeout);
        console.error("FATAL: " + err.stack);
        parentPort.postMessage({ type: 'result', result: null });
    }
}

run();
