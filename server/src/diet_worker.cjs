const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');

const { FOOD_DATABASE, details, islandCount, islandsPerWorker, maxGens, targetCalories, proteinTarget, fatTarget, carbTarget, essentialKeys, nutrientNames, nutrientConfig, logPath } = workerData;

const foodMap = new Map();
FOOD_DATABASE.forEach(f => foodMap.set(f.name, f));

const evalCache = new Map();
const getCacheKey = (ingredients) => {
    const active = [];
    ingredients.forEach((amt, name) => {
        if (amt > 0) active.push(`${name}:${amt}`);
    });
    return active.sort().join('|');
};

const evaluate = (ingredients, gen) => {
    const cacheKey = getCacheKey(ingredients);
    if (evalCache.has(cacheKey)) return evalCache.get(cacheKey);

    const totals = {};
    Object.keys(nutrientConfig).forEach(k => totals[k] = 0);
    const macroKeys = ['energy', 'protein', 'carbs', 'fat'];

    const sectionCounts = { "Proteins": 0, "Carbs": 0, "Fruits": 0, "Fiber and Vegetables": 0 };

    ingredients.forEach((amount, name) => {
        const food = foodMap.get(name);
        if (!food) return;
        
        if (amount > 0) {
            if (sectionCounts[food.section] !== undefined) sectionCounts[food.section]++;
        }

        const factor = amount / 100;
        totals.energy += factor * food.calories;
        totals.protein += factor * food.protein;
        totals.carbs += factor * food.carbs;
        totals.fat += factor * food.fat;
        
        if (food.nutrients) {
            for (const n in food.nutrients) {
                const key = n === 'fibre' ? 'fiber' : n;
                if (totals[key] !== undefined && !macroKeys.includes(key)) {
                    totals[key] += factor * food.nutrients[n]; 
                }
            }
        }
    });

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
        if (k === 'c' && val > 2000) nutrientScore -= (val - 2000) * 10;
        if (k === 'd' && val > 100) nutrientScore -= (val - 100) * 1000;
        if (k === 'potassium' && val > 6000) nutrientScore -= (val - 6000) * 50;
        if (k === 'zinc' && val > 40) nutrientScore -= (val - 40) * 1000;
        if (k === 'iron' && val > 45) nutrientScore -= (val - 45) * 1000;

        if (pct >= 0.95) metCount++;
        if (boundedPct < worst.pct) worst = { name: nutrientNames[k] || k, pct: boundedPct, key: k };
    });

    // VARIETY LOGIC
    let varietyPenalty = 0;
    for (const section in sectionCounts) {
        const count = sectionCounts[section];
        if (count === 1) varietyPenalty += 150000; 
        if (count > 3) varietyPenalty += (count - 3) * 20000; 
        if (count === 0) varietyPenalty += 50000; 
    }

    const o3 = totals.omega3 || 0;
    const o6 = totals.omega6 || 0;
    const omegaRatio = o6 > 0 ? o3 / o6 : 1.0;
    if (omegaRatio < 0.25) nutrientScore -= (0.25 - omegaRatio) * 200000;
    else nutrientScore += Math.min(omegaRatio, 2.0) * 10000;

    nutrientScore += metCount * 15000;

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

    // CUSTOM LIMITS & MUST HAVES
    let amountPenalty = 0;
    ingredients.forEach((amt, name) => {
        const food = foodMap.get(name);
        if (!food) return;
        
        const mustHave = details.mustHaveFoods?.find(m => m.name === name);
        if (mustHave) {
            const min = mustHave.min || 0;
            const max = mustHave.max || 1000;
            if (amt < min) amountPenalty += (min - amt) * 5000;
            if (amt > max) amountPenalty += (amt - max) * 5000;
        } else {
            const max = (details.customMaxAmounts && details.customMaxAmounts[name] !== undefined) ? details.customMaxAmounts[name] : food.maxAmount;
            if (amt > max) amountPenalty += (amt - max) * 1000;
            if (amt > 0 && amt < food.minAmount) amountPenalty += 200000;
        }
    });

    const res = { 
        score: (nutrientScore - macroPenalty - amountPenalty - varietyPenalty) || -999999, 
        totals, 
        accuracy: Math.round((metCount/essentialKeys.length)*1000)/10, 
        worst, metCount,
        worstMacro: (calDiff > 50) ? 'energy' : (fatDiff > 5) ? 'fat' : 'protein'
    };
    evalCache.set(cacheKey, res);
    return res;
};

const likedFoods = FOOD_DATABASE.filter(f => (details.likedFoods && details.likedFoods.includes(f.name)) || (details.mustHaveFoods && details.mustHaveFoods.some(m => m.name === f.name)));

let islands = Array.from({ length: islandsPerWorker }, () => 
    Array.from({ length: 50 }, (_, i) => {
        const genome = new Map();
        likedFoods.forEach(f => {
            const mustHave = details.mustHaveFoods?.find(m => m.name === f.name);
            if (mustHave) {
                const min = mustHave.min || 0;
                const max = mustHave.max || 150;
                genome.set(f.name, Math.round(min + Math.random() * (max - min)));
            } else {
                let val = Math.random() < 0.15 ? 50 + Math.random() * 150 : 0;
                const max = (details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? details.customMaxAmounts[f.name] : f.maxAmount;
                if (val > max) val = max;
                if (val > 0 && val < f.minAmount) val = f.minAmount;
                genome.set(f.name, Math.round(val));
            }
        });
        return { 
            genome, 
            team: i < 20 ? 'snipers' : i < 30 ? 'macro-snipers' : i < 40 ? 'sculptors' : i < 47 ? 'explorers' : 'elitists',
            res: null
        };
    })
);

// INITIAL EVALUATION
islands.forEach(isl => isl.forEach(p => p.res = evaluate(p.genome, 0)));

parentPort?.on('message', (msg) => {
    if (msg.type === 'import') {
        msg.genomes.forEach((g) => {
            const targetIsland = islands[Math.floor(Math.random() * islands.length)];
            targetIsland[targetIsland.length - 1] = { genome: new Map(Object.entries(g.genome)), team: 'elitists', res: g.res };
        });
    }
});

async function run() {
    let currentGen = 0;
    while (currentGen < maxGens) {
        currentGen++;
        if (currentGen % 25 === 0) await new Promise(r => setTimeout(r, 1));

        islands = islands.map(island => {
            const scored = island.sort((a, b) => (b.res?.score || -Infinity) - (a.res?.score || -Infinity));
            const bestOfIsland = scored[0];
            const nextPop = [];
            
            for(let e=0; e<15; e++) nextPop.push({ genome: new Map(bestOfIsland.genome), team: 'elitists', res: bestOfIsland.res }); 

            while (nextPop.length < 100) {
                const parentA = scored[Math.floor(Math.random() * 10)];
                const parentB = scored[Math.floor(Math.random() * 30)];
                const childGenome = new Map();
                likedFoods.forEach(f => {
                    childGenome.set(f.name, Math.random() < 0.6 ? parentA.genome.get(f.name) : parentB.genome.get(f.name));
                });

                const team = island[nextPop.length]?.team || 'explorers';
                const scale = currentGen < 1000 ? 50 : 10;

                likedFoods.forEach(f => {
                    const mustHave = details.mustHaveFoods?.find((m) => m.name === f.name);
                    let val = childGenome.get(f.name) || 0;
                    const roll = Math.random();
                    
                    if (roll < 0.15) {
                        if (mustHave) {
                            val += (Math.random() * 20 - 10);
                        } else if (team === 'snipers') {
                            const wk = bestOfIsland.res.worst.key;
                            if (wk && (f.nutrients[wk] || 0) > 0) val += scale * 10;
                        } else if (team === 'macro-snipers') {
                            const mk = bestOfIsland.res.worstMacro;
                            if (bestOfIsland.res.totals[mk] < (mk === 'energy' ? targetCalories : fatTarget)) val += scale * 8;
                            else val -= scale * 8;
                        } else if (team === 'sculptors') {
                            if (bestOfIsland.res.totals.energy > targetCalories) val -= scale * 5;
                        } else if (team === 'explorers') {
                            val += (Math.random() * 2 - 1) * scale * 20;
                        }
                        if (!mustHave && Math.random() < 0.02) val = val === 0 ? f.minAmount : 0;
                    }

                    if (mustHave) {
                        const min = mustHave.min || 0;
                        const max = mustHave.max || 1000;
                        val = Math.max(min, Math.min(max, Math.round(val)));
                    } else {
                        const max = (details.customMaxAmounts && details.customMaxAmounts[f.name] !== undefined) ? details.customMaxAmounts[f.name] : f.maxAmount;
                        val = Math.max(0, Math.min(max, Math.round(val)));
                        if (val > 0 && val < f.minAmount) val = 0; 
                    }
                    childGenome.set(f.name, val);
                });
                
                nextPop.push({ genome: childGenome, team, res: evaluate(childGenome, currentGen) });
            }
            return nextPop;
        });

        if (currentGen % 60 === 0) parentPort?.postMessage({ type: 'migration', gen: currentGen, bests: islands.map(isl => ({ genome: Object.fromEntries(isl[0].genome), res: isl[0].res })) });
        if (currentGen % 20 === 0) {
            parentPort?.postMessage({ 
                type: 'progress', 
                gen: currentGen, 
                best: { genome: Object.fromEntries(islands[0][0].genome), res: islands[0][0].res }, 
                islandAccuracies: islands.map(isl => isl.slice(0, 50).map(p => p.res ? p.res.accuracy : 0)) 
            });
        }
    }
    
    parentPort?.postMessage({ type: 'done', best: { genome: Object.fromEntries(islands[0][0].genome), res: islands[0][0].res } });
}

run();
