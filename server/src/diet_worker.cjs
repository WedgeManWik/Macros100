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

let islands = Array.from({ length: islandsPerWorker }, () => 
    Array.from({ length: 50 }, (_, i) => {
        const genome = {};
        likedFoods.forEach((f) => {
            const mustHave = (details.mustHaveFoods || []).find((m) => m.name === f.name);
            if (mustHave) {
                genome[f.name] = Math.round((mustHave.min || 0) + Math.random() * ((mustHave.max || 150) - (mustHave.min || 0)));
            } else {
                let val = Math.random() < 0.15 ? 50 + Math.random() * 150 : 0;
                const max = (details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? details.customMaxAmounts[f.name] : f.maxAmount;
                if (val > max) val = max;
                genome[f.name] = Math.round(val);
            }
        });
        return { 
            genome, 
            team: i < 20 ? 'snipers' : i < 30 ? 'macro-snipers' : i < 40 ? 'sculptors' : i < 47 ? 'explorers' : 'elitists',
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
        if (currentGen % 10 === 0) await new Promise(r => setTimeout(r, 0));

        // Process incoming migrations
        if (incomingGenomes.length > 0) {
            islands.forEach(island => {
                incomingGenomes.forEach(genome => {
                    const worstIdx = island.length - 1; // Replace worst
                    island[worstIdx] = { genome: { ...genome }, team: 'explorer', res: evaluate(genome) };
                    island.sort((a, b) => (b.res ? b.res.score : -Infinity) - (a.res ? a.res.score : -Infinity));
                });
            });
            incomingGenomes.length = 0;
        }

        islands = islands.map(island => {
            const scored = island.sort((a, b) => (b.res ? b.res.score : -Infinity) - (a.res ? a.res.score : -Infinity));
            const bestOfIsland = scored[0];
            const nextPop = [];
            
            // Reduced elitism for better diversity
            for(let e=0; e<4; e++) nextPop.push({ genome: { ...bestOfIsland.genome }, team: 'elitists', res: bestOfIsland.res }); 

            while (nextPop.length < 50) {
                // Broader parent selection for diversity
                const parentA = scored[Math.floor(Math.random() * 10)];
                const parentB = scored[Math.floor(Math.random() * 25)];
                const childGenome = {};
                likedFoods.forEach((f) => {
                    childGenome[f.name] = Math.random() < 0.6 ? parentA.genome[f.name] : parentB.genome[f.name];
                });

                const team = island[nextPop.length] ? island[nextPop.length].team : 'explorers';
                const scale = currentGen < 1000 ? 50 : 10;

                likedFoods.forEach((f) => {
                    const mustHave = (details.mustHaveFoods || []).find((m) => m.name === f.name);
                    let val = childGenome[f.name] || 0;
                    
                    if (Math.random() < 0.15) {
                        if (mustHave) {
                            val += (Math.random() * 20 - 10);
                        } else if (team === 'snipers') {
                            const wk = bestOfIsland.res.worst.key;
                            if (wk && f.nutrients[wk] > 0) val += scale * 10;
                        } else if (team === 'macro-snipers') {
                            const mk = bestOfIsland.res.worstMacro;
                            if (bestOfIsland.res.totals[mk] < (mk === 'energy' ? targetCalories : fatTarget)) val += scale * 8;
                            else val -= scale * 8;
                        } else if (team === 'explorers') {
                            val += (Math.random() * 2 - 1) * scale * 20;
                        }
                        if (!mustHave && Math.random() < 0.02) val = val === 0 ? (f.minAmount || 20) : 0;
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

            // Send migration bests every 40 generations
            if (currentGen % 40 === 0) {
                const bests = islands.map(isl => isl[0].genome);
                parentPort.postMessage({ type: 'migration', bests });
            }
        }
    }
    
    const finalBest = islands[0][0];
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
            unit: k === 'energy' ? 'kcal' : (k === 'water' ? 'g' : (['a', 'folate', 'k'].includes(k) ? 'µg' : 'mg')),
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
