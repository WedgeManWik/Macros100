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
                const key = n === 'fibre' ? 'fiber' : n;
                if (totals[key] !== undefined && !macroKeys.includes(key)) {
                    totals[key] += factor * (food.nutrients[n] || 0); 
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
        if (pct < 0.05) nutrientScore -= 10000; 
        
        if (k === 'a' && val > 3000) nutrientScore -= (val - 3000) * 100;
        if (k === 'zinc' && val > 40) nutrientScore -= (val - 40) * 1000;

        if (pct >= 0.95) metCount++;
        if (boundedPct < worst.pct) worst = { name: nutrientNames[k] || k, pct: boundedPct, key: k };
    });

    let ratioPenalty = 0;
    const o3 = totals.omega3 || 0;
    const o6 = totals.omega6 || 0;
    if (o3 > 0) {
        const ratio = o6 / o3;
        if (ratio < 1) ratioPenalty += (1 - ratio) * 10000;
        if (ratio > 4) ratioPenalty += (ratio - 4) * 10000;
    } else if (o6 > 0) {
        ratioPenalty += 50000;
    }

    let varietyPenalty = 0;
    for (const section in sectionCounts) {
        const count = sectionCounts[section];
        if (count === 1) varietyPenalty += 150000; 
        if (count > 3) varietyPenalty += (count - 3) * 20000; 
        if (count === 0) varietyPenalty += 50000; 
    }

    const calDiff = Math.abs(totals.energy - targetCalories);
    const fatDiff = Math.abs(totals.fat - fatTarget);
    const pDiff = Math.abs(totals.protein - proteinTarget);
    const cDiff = Math.abs(totals.carbs - carbTarget);

    const metPct = metCount / essentialKeys.length;
    const macroWeight = 0.05 + (Math.pow(metPct, 4) * 9.95); 

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
            if (amt > 0 && amt < (food.minAmount || 20)) amountPenalty += 200000;
        }
    }

    return { 
        score: (nutrientScore - macroPenalty - amountPenalty - varietyPenalty - ratioPenalty) || -999999, 
        totals, 
        accuracy: Math.round((metCount/essentialKeys.length)*1000)/10, 
        worst, metCount,
        worstMacro: (calDiff > 50) ? 'energy' : (fatDiff > 5) ? 'fat' : 'protein'
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
            // Start with only 2-4 items per section for cleaner initial diets
            let val = Math.random() < 0.1 ? 50 + Math.random() * 100 : 0;
            const max = (details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? details.customMaxAmounts[f.name] : f.maxAmount;
            if (val > max) val = max;
            genome[f.name] = Math.round(val);
        }
    });
    return genome;
};

let islands = Array.from({ length: 6 }, () => 
    Array.from({ length: 20 }, (_, i) => {
        const genome = createRandomGenome();
        return { 
            genome, 
            team: i < 5 ? 'snipers' : i < 10 ? 'macro-snipers' : i < 15 ? 'sculptors' : 'elitists',
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
        if (currentGen % 20 === 0) await new Promise(r => setTimeout(r, 0));

        // Process incoming migrations
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
            
            // Keep top 2 elitists
            for(let e=0; e<2; e++) nextPop.push({ genome: { ...scored[e].genome }, team: 'elitists', res: scored[e].res }); 

            while (nextPop.length < 20) {
                const parentA = scored[Math.floor(Math.random() * 4)];
                const parentB = scored[Math.floor(Math.random() * 8)];
                const childGenome = {};
                likedFoods.forEach((f) => {
                    childGenome[f.name] = Math.random() < 0.7 ? parentA.genome[f.name] : parentB.genome[f.name];
                });

                const team = island[nextPop.length] ? island[nextPop.length].team : 'snipers';
                const scale = currentGen < 1000 ? 60 : 20;

                likedFoods.forEach((f) => {
                    const mustHave = (details.mustHaveFoods || []).find((m) => m.name === f.name);
                    let val = childGenome[f.name] || 0;
                    
                    if (Math.random() < 0.25) { // Increased mutation frequency
                        if (mustHave) {
                            val += (Math.random() * 30 - 15);
                        } else if (team === 'snipers') {
                            const wk = bestOfIsland.res.worst.key;
                            // Aggressively boost foods that solve the bottleneck
                            if (wk && f.nutrients[wk] > 0) {
                                if (val === 0) val = 40 + Math.random() * 40;
                                else val += scale * 5;
                            } else if (Math.random() < 0.05) {
                                val = 0; // Cut non-contributing foods
                            }
                        } else if (team === 'macro-snipers') {
                            const mk = bestOfIsland.res.worstMacro;
                            if (bestOfIsland.res.totals[mk] < (mk === 'energy' ? targetCalories : (mk === 'fat' ? fatTarget : proteinTarget))) {
                                if (f[mk] > 5) val += scale * 5;
                            } else {
                                if (f[mk] > 5) val -= scale * 5;
                            }
                        } else if (Math.random() < 0.05) { // Occasional shuffle
                            val = Math.random() < 0.1 ? 50 + Math.random() * 100 : 0;
                        } else {
                            val += (Math.random() * 2 - 1) * scale;
                        }
                    }

                    const max = (details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? details.customMaxAmounts[f.name] : f.maxAmount;
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
    
    const finalBest = islands[0][0];

    // AUTOMATIC WATER FILLING
    const waterTarget = nutrientConfig.water ? nutrientConfig.water.target : 0;
    const currentWater = finalBest.res.totals.water || 0;
    if (currentWater < waterTarget) {
        const needed = waterTarget - currentWater;
        const mineralWater = foodMap.get('Mineral Water');
        if (mineralWater) {
            finalBest.genome['Mineral Water'] = (finalBest.genome['Mineral Water'] || 0) + Math.round(needed);
            // Re-calculate totals for the final output
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
