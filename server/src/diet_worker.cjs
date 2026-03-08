const { parentPort, workerData } = require('worker_threads');

const { 
  FOOD_DATABASE, details, islandsPerWorker, maxGens, 
  targetCalories, proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const foodMap = new Map();
FOOD_DATABASE.forEach((f) => foodMap.set(f.name, f));

const evaluate = (ingredients) => {
    const totals = {};
    Object.keys(nutrientConfig).forEach(k => totals[k] = 0);
    const macroKeys = ['energy', 'protein', 'carbs', 'fat'];

    const sectionCounts = { "Proteins": 0, "Carbs": 0, "Fruits": 0, "Fiber and Vegetables": 0 };

    for (const name in ingredients) {
        const amount = ingredients[name];
        const food = foodMap.get(name);
        if (!food || amount <= 0) continue;
        
        if (sectionCounts[food.section] !== undefined) sectionCounts[food.section]++;

        const factor = amount / 100;
        totals.energy += factor * food.calories;
        totals.protein += factor * food.protein;
        totals.carbs += factor * food.carbs;
        totals.fat += factor * food.fat;
        
        if (food.nutrients) {
            for (const n in food.nutrients) {
                if (totals[n] !== undefined && !macroKeys.includes(n)) {
                    totals[n] += factor * (food.nutrients[n] || 0); 
                }
            }
        }
    }

    let nutrientScore = 0;
    let metCount = 0;
    let worst = { name: '', pct: 1.0, key: '' };

    essentialKeys.forEach((k) => {
        const target = nutrientConfig[k].target;
        const val = totals[k] || 0;
        const pct = target > 0 ? val / target : 1.0;
        const boundedPct = Math.min(1.0, pct);
        
        nutrientScore += boundedPct * 1000;
        if (pct < 0.1) nutrientScore -= 5000; // Penalty for near-zero essential nutrients
        
        if (k === 'a' && val > 3000) nutrientScore -= (val - 3000) * 100;
        if (k === 'zinc' && val > 40) nutrientScore -= (val - 40) * 1000;

        if (pct >= 0.95) metCount++;
        if (boundedPct < worst.pct) worst = { name: nutrientNames[k] || k, pct: boundedPct, key: k };
    });

    // Bottleneck Penalty: Heavily penalize the single worst nutrient to force improvement
    let bottleneckPenalty = (1.0 - worst.pct) * 20000;

    let ratioPenalty = 0;
    const o3 = totals.omega3 || 0;
    const o6 = totals.omega6 || 0;
    if (o3 > 0) {
        const ratio = o6 / o3;
        if (ratio < 1) ratioPenalty += (1 - ratio) * 10000;
        if (ratio > 4) ratioPenalty += (ratio - 4) * 10000;
    } else if (o6 > 0) {
        ratioPenalty += 20000;
    }

    // REBALANCED VARIETY PENALTIES
    let varietyPenalty = 0;
    for (const section in sectionCounts) {
        const count = sectionCounts[section];
        if (count === 0) varietyPenalty += 25000; // High penalty for skipping a section
        else if (count === 1) varietyPenalty += 10000; // Moderate penalty for no variety
        else if (count > 4) varietyPenalty += (count - 4) * 5000; // Penalty for too many items
    }

    const calDiff = Math.abs(totals.energy - targetCalories);
    const fatDiff = Math.abs(totals.fat - fatTarget);
    const pDiff = Math.abs(totals.protein - proteinTarget);
    const cDiff = Math.abs(totals.carbs - carbTarget);

    const metPct = metCount / essentialKeys.length;
    const macroWeight = 0.5 + (Math.pow(metPct, 2) * 9.5); 

    const macroPenalty = (
        Math.pow(Math.max(0, calDiff - 20) / 5, 2) + 
        Math.pow(Math.max(0, fatDiff - 2) * 5, 2) + 
        Math.pow(Math.max(0, pDiff - 2) * 5, 2) +
        Math.pow(Math.max(0, cDiff - 5) * 2, 2)
    ) * 0.1 * macroWeight;

    let amountPenalty = 0;
    for (const name in ingredients) {
        const amt = ingredients[name];
        const food = foodMap.get(name);
        if (!food) continue;
        
        const mustHave = (details.mustHaveFoods || []).find((m) => m.name === name);
        if (mustHave) {
            const min = mustHave.min || 0;
            const max = mustHave.max || 1000;
            if (amt < min) amountPenalty += (min - amt) * 5000;
            if (amt > max) amountPenalty += (amt - max) * 5000;
        } else {
            const max = (details.customMaxAmounts && details.customMaxAmounts[name] !== undefined) ? details.customMaxAmounts[name] : food.maxAmount;
            if (amt > max) amountPenalty += (amt - max) * 1000;
            if (amt > 0 && amt < (food.minAmount || 20)) amountPenalty += 50000;
        }
    }

    return { 
        score: (nutrientScore - macroPenalty - amountPenalty - varietyPenalty - ratioPenalty - bottleneckPenalty) || -999999, 
        totals, 
        accuracy: Math.round((metCount/essentialKeys.length)*1000)/10, 
        worst, metCount,
        worstMacro: (calDiff > 50) ? 'energy' : (fatDiff > 10) ? 'fat' : (pDiff > 10) ? 'protein' : 'carbs'
    };
};

const likedFoods = FOOD_DATABASE.filter((f) => (details.likedFoods && details.likedFoods.includes(f.name)) || (details.mustHaveFoods && details.mustHaveFoods.some((m) => m.name === f.name)));

const createRandomGenome = () => {
    const genome = {};
    likedFoods.forEach((f) => {
        const mustHave = (details.mustHaveFoods || []).find((m) => m.name === f.name);
        if (mustHave) {
            genome[f.name] = Math.round((mustHave.min || 0) + Math.random() * ((mustHave.max || 150) - (mustHave.min || 0)));
        } else {
            let val = Math.random() < 0.15 ? 50 + Math.random() * 100 : 0;
            const max = (details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? details.customMaxAmounts[f.name] : f.maxAmount;
            if (val > max) val = max;
            genome[f.name] = Math.round(val);
        }
    });
    return genome;
};

let islands = Array.from({ length: islandsPerWorker || 8 }, () => 
    Array.from({ length: 30 }, (_, i) => {
        const genome = createRandomGenome();
        return { 
            genome, 
            team: i < 10 ? 'snipers' : i < 20 ? 'macro-snipers' : i < 27 ? 'sculptors' : 'elitists',
            res: null
        };
    })
);

islands.forEach(isl => isl.forEach(p => p.res = evaluate(p.genome)));

const incomingGenomes = [];
parentPort.on('message', (msg) => {
    if (msg.type === 'import') {
        incomingGenomes.push(...msg.genomes);
    }
});

async function run() {
    let currentGen = 0;
    while (currentGen < maxGens) {
        currentGen++;
        if (currentGen % 25 === 0) await new Promise(r => setTimeout(r, 0));

        if (incomingGenomes.length > 0) {
            islands.forEach(island => {
                incomingGenomes.forEach(genome => {
                    const worstIdx = island.length - 1;
                    island[worstIdx] = { genome: { ...genome }, team: 'snipers', res: evaluate(genome) };
                });
            });
            incomingGenomes.length = 0;
            islands.forEach(isl => isl.sort((a, b) => (b.res ? b.res.score : -Infinity) - (a.res ? a.res.score : -Infinity)));
        }

        islands = islands.map(island => {
            const scored = island.sort((a, b) => (b.res ? b.res.score : -Infinity) - (a.res ? a.res.score : -Infinity));
            const bestOfIsland = scored[0];
            const nextPop = [];
            
            for(let e=0; e<3; e++) nextPop.push({ genome: { ...scored[e].genome }, team: 'elitists', res: scored[e].res }); 

            while (nextPop.length < 30) {
                const parentA = scored[Math.floor(Math.random() * 6)];
                const parentB = scored[Math.floor(Math.random() * 15)];
                const childGenome = {};
                likedFoods.forEach((f) => {
                    childGenome[f.name] = Math.random() < 0.7 ? parentA.genome[f.name] : parentB.genome[f.name];
                });

                const team = island[nextPop.length] ? island[nextPop.length].team : 'snipers';
                const scale = currentGen < 1000 ? 60 : 20;

                // SPECIALIZED MUTATION LOGIC
                if (Math.random() < 0.3) {
                    if (team === 'snipers') {
                        const wk = bestOfIsland.res.worst.key;
                        if (wk) {
                            // Find the food in our child genome that is best for this missing nutrient
                            const foodToBoost = likedFoods
                                .filter(f => (wk === 'energy' ? f.calories : (wk === 'protein' ? f.protein : (wk === 'fat' ? f.fat : (wk === 'carbs' ? f.carbs : (f.nutrients[wk] || 0))))) > 0)
                                .sort((a, b) => {
                                    const valA = (wk === 'energy' ? a.calories : (wk === 'protein' ? a.protein : (wk === 'fat' ? a.fat : (wk === 'carbs' ? a.carbs : (a.nutrients[wk] || 0)))));
                                    const valB = (wk === 'energy' ? b.calories : (wk === 'protein' ? b.protein : (wk === 'fat' ? b.fat : (wk === 'carbs' ? b.carbs : (b.nutrients[wk] || 0)))));
                                    return valB - valA;
                                })[Math.floor(Math.random() * 3)]; // Pick from top 3 candidates

                            if (foodToBoost) {
                                let amt = childGenome[foodToBoost.name] || 0;
                                if (amt === 0) childGenome[foodToBoost.name] = 50 + Math.random() * 50;
                                else childGenome[foodToBoost.name] += scale * 4;
                            }
                        }
                    } else if (team === 'macro-snipers') {
                        const mk = bestOfIsland.res.worstMacro;
                        const targetVal = (mk === 'energy' ? targetCalories : (mk === 'fat' ? fatTarget : (mk === 'protein' ? proteinTarget : carbTarget)));
                        const isUnder = bestOfIsland.res.totals[mk] < targetVal;
                        
                        // Pick a food that heavily impacts this macro
                        const foods = likedFoods.filter(f => (mk === 'energy' ? f.calories : f[mk]) > 5);
                        if (foods.length > 0) {
                            const f = foods[Math.floor(Math.random() * foods.length)];
                            let amt = childGenome[f.name] || 0;
                            if (isUnder) childGenome[f.name] = amt + scale * 3;
                            else childGenome[f.name] = Math.max(0, amt - scale * 3);
                        }
                    } else {
                        // Regular random mutation
                        const f = likedFoods[Math.floor(Math.random() * likedFoods.length)];
                        let amt = childGenome[f.name] || 0;
                        if (Math.random() < 0.1) childGenome[f.name] = Math.random() < 0.5 ? 0 : 50 + Math.random() * 100;
                        else childGenome[f.name] = Math.max(0, amt + (Math.random() * 2 - 1) * scale);
                    }
                }

                // Final clamp
                likedFoods.forEach((f) => {
                    const mustHave = (details.mustHaveFoods || []).find((m) => m.name === f.name);
                    const max = (details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? details.customMaxAmounts[f.name] : f.maxAmount;
                    let val = childGenome[f.name] || 0;
                    val = Math.max(mustHave ? (mustHave.min || 0) : 0, Math.min(max, Math.round(val)));
                    childGenome[f.name] = val;
                });
                
                nextPop.push({ genome: childGenome, team, res: evaluate(childGenome) });
            }
            return nextPop;
        });

        if (currentGen % 20 === 0) {
            const best = islands[0][0];
            parentPort.postMessage({ 
                type: 'progress', 
                gen: currentGen, 
                accuracy: best.res.accuracy,
                telemetry: {
                    calories: Math.round(best.res.totals.energy),
                    fat: Math.round(best.res.totals.fat),
                    score: Math.round(best.res.score),
                    worstNutrient: best.res.worst.name,
                    worstPct: Math.round(best.res.worst.pct * 100),
                    metCount: best.res.metCount,
                    totalEssential: essentialKeys.length,
                    islands: islands.map(isl => isl.slice(0, 10).map(p => p.res ? p.res.accuracy : 0))
                }
            });

            if (currentGen % 50 === 0) {
                const bests = islands.map(isl => isl[0].genome);
                parentPort.postMessage({ type: 'migration', bests });
            }
        }
    }
    
    const allCandidates = islands.flat();
    allCandidates.sort((a, b) => (b.res ? b.res.score : -Infinity) - (a.res ? a.res.score : -Infinity));
    const finalBest = allCandidates[0];

    const waterTarget = nutrientConfig.water ? nutrientConfig.water.target : 0;
    const currentWater = finalBest.res.totals.water || 0;
    if (currentWater < waterTarget) {
        const needed = waterTarget - currentWater;
        const mineralWater = foodMap.get('Mineral Water');
        if (mineralWater) {
            finalBest.genome['Mineral Water'] = (finalBest.genome['Mineral Water'] || 0) + Math.round(needed);
            finalBest.res = evaluate(finalBest.genome);
        }
    }

    const sectionedIngredients = {};
    for (const name in finalBest.genome) {
        const amount = finalBest.genome[name];
        if (amount > 0) {
            const food = foodMap.get(name);
            if (!sectionedIngredients[food.section]) sectionedIngredients[food.section] = [];
            sectionedIngredients[food.section].push({
                name, icon: food.icon, amount, calories: Math.round((amount/100) * food.calories)
            });
        }
    }

    const micronutrients = {};
    Object.keys(nutrientConfig).forEach(k => {
        const target = nutrientConfig[k].target;
        const val = finalBest.res.totals[k] || 0;
        micronutrients[k] = {
            amount: val,
            total: target > 0 ? (val / target) * 100 : 100,
            unit: k === 'energy' ? 'kcal' : (['water', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'omega3', 'omega6', 'fatSat', 'fatPoly', 'fatMono'].includes(k) ? 'g' : (['a', 'folate', 'k'].includes(k) ? 'µg' : 'mg')),
            sources: []
        };
    });

    parentPort.postMessage({ 
        type: 'result', 
        result: {
            genome: finalBest.genome,
            score: finalBest.res.score,
            targetCalories,
            actualCalories: Math.round(finalBest.res.totals.energy),
            accuracy: finalBest.res.accuracy,
            macros: {
                protein: Math.round(finalBest.res.totals.protein),
                carbs: Math.round(finalBest.res.totals.carbs),
                fat: Math.round(finalBest.res.totals.fat)
            },
            sectionedIngredients,
            micronutrients
        }
    });
}

run();
