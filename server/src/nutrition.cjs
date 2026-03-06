const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { FOOD_DATABASE } = require('./foods.cjs');

const nutrientNames = {
    energy: 'Calories', water: 'Water', protein: 'Protein', carbs: 'Carbs', fat: 'Fat', fatSat: 'Saturated Fat', fatPoly: 'Polyunsaturated Fat', fatMono: 'Monounsaturated Fat', fatTrans: 'Trans Fat', fiber: 'Fiber', starch: 'Starch', sugars: 'Sugar', omega3: 'Omega-3', omega6: 'Omega-6', cholesterol: 'Cholesterol',
    b1: 'Vitamin B1', b2: 'Vitamin B2', b3: 'Vitamin B3', b5: 'Vitamin B5', b6: 'Vitamin B6', b12: 'Vitamin B12', folate: 'Folate', a: 'Vitamin A', c: 'Vitamin C', d: 'Vitamin D', e: 'Vitamin E', k: 'Vitamin K',
    calcium: 'Calcium', copper: 'Copper', iron: 'Iron', magnesium: 'Magnesium', manganese: 'Manganese', phosphorus: 'Phosphorus', potassium: 'Potassium', selenium: 'Selenium', sodium: 'Sodium', zinc: 'Zinc',
    iodine: 'Iodine', fluoride: 'Fluoride', caffeine: 'Caffeine', alcohol: 'Alcohol',
    cystine: 'Cystine', histidine: 'Histidine', isoleucine: 'Isoleucine', leucine: 'Leucine', lysine: 'Lysine', methionine: 'Methionine', phenylalanine: 'Phenylalanine', threonine: 'Threonine', tryptophan: 'Tryptophan', tyrosine: 'Tyrosine', valine: 'Valine'
};

async function generateDietAsync(details, onProgress) {
  let targetCalories;
  if (details.maintenanceCalories !== undefined && details.calorieOffset !== undefined) {
    targetCalories = parseFloat(details.maintenanceCalories) + parseFloat(details.calorieOffset);
  } else {
    const lbm = details.weight * (1 - (details.bodyFat / 100));
    const bmr = 370 + (21.6 * lbm);
    const offset = details.goal === 'fast-lose' ? -500 : details.goal === 'moderate-lose' ? -250 : details.goal === 'moderate-gain' ? 250 : details.goal === 'fast-gain' ? 500 : 0;
    targetCalories = (bmr * details.activityLevel) + offset;
  }
  
  const rdaScale = details.weight / 70;
  let proteinTarget = 0, fatTarget = 0, carbTarget = 0;
  const calcMacro = (config, type, tdee, weight) => {
    if (!config) return 0;
    if (config.mode === 'g/kg') return weight * config.value;
    if (config.mode === 'g') return config.value;
    if (config.mode === '%') return (tdee * (config.value / 100)) / (type === 'f' ? 9 : 4);
    return 0; 
  };

  if (details.macros) {
    proteinTarget = calcMacro(details.macros.protein, 'p', targetCalories, details.weight);
    fatTarget = calcMacro(details.macros.fat, 'f', targetCalories, details.weight);
    carbTarget = calcMacro(details.macros.carbs, 'c', targetCalories, details.weight);
    const usedCals = (proteinTarget * 4) + (fatTarget * 9) + (carbTarget * 4);
    const remainingCals = Math.max(0, targetCalories - usedCals);
    if (details.macros.protein?.mode === 'remainder') proteinTarget = remainingCals / 4;
    else if (details.macros.fat?.mode === 'remainder') fatTarget = remainingCals / 9;
    else if (details.macros.carbs?.mode === 'remainder') carbTarget = remainingCals / 4;
    else if (usedCals < targetCalories) carbTarget += remainingCals / 4;
  }

  const nutrientConfig = {
    energy: { target: targetCalories },
    water: { target: 2500 * rdaScale, essential: true },
    protein: { target: proteinTarget, essential: true },
    carbs: { target: carbTarget },
    fat: { target: fatTarget },
    fatSat: { target: targetCalories * 0.1 / 9 },
    fatPoly: { target: targetCalories * 0.08 / 9 },
    fiber: { target: 30 * rdaScale, essential: true },
    sugars: { target: 50 },
    omega3: { target: (details.gender === 'male' ? 4.25 : 3) * rdaScale, essential: true },
    omega6: { target: (details.gender === 'male' ? 17 : 12) * rdaScale, essential: true },
    cholesterol: { target: 300 },
    b1: { target: 1.2 * rdaScale, essential: true },
    b2: { target: 1.3 * rdaScale, essential: true },
    b3: { target: 16 * rdaScale, essential: true },
    b5: { target: 5 * rdaScale, essential: true },
    b6: { target: 1.7 * rdaScale, essential: true },
    b12: { target: 2.4 * rdaScale, essential: true },
    folate: { target: 400 * rdaScale, essential: true },
    a: { target: 900 * rdaScale, essential: true },
    c: { target: 90 * rdaScale, essential: true },
    d: { target: 20 * rdaScale, essential: true },
    e: { target: 15 * rdaScale, essential: true },
    k: { target: 120 * rdaScale, essential: true },
    calcium: { target: 1300 * rdaScale, essential: true },
    copper: { target: 0.9 * rdaScale, essential: true },
    iron: { target: 18 * rdaScale, essential: true },
    magnesium: { target: 420 * rdaScale, essential: true },
    manganese: { target: 2.3 * rdaScale, essential: true },
    phosphorus: { target: 1250 * rdaScale, essential: true },
    potassium: { target: 4700 * rdaScale, essential: true },
    selenium: { target: 55 * rdaScale, essential: true },
    sodium: { target: 2300 * rdaScale, essential: true },
    zinc: { target: 11 * rdaScale, essential: true },
    cystine: { target: 500 * rdaScale, essential: true },
    histidine: { target: 700 * rdaScale, essential: true },
    isoleucine: { target: 1400 * rdaScale, essential: true },
    leucine: { target: 2700 * rdaScale, essential: true },
    lysine: { target: 2100 * rdaScale, essential: true },
    methionine: { target: 700 * rdaScale, essential: true },
    phenylalanine: { target: 1100 * rdaScale, essential: true },
    threonine: { target: 1000 * rdaScale, essential: true },
    tryptophan: { target: 280 * rdaScale, essential: true },
    tyrosine: { target: 800 * rdaScale, essential: true },
    valine: { target: 1600 * rdaScale, essential: true }
  };

  const essentialKeys = Object.keys(nutrientConfig).filter(k => nutrientConfig[k].essential);
  const maxGens = 4000;
  const workerCount = 2; 
  const islandsPerWorker = 4; 

  let globalBest = null;
  let completedWorkers = 0;
  const workers = [];
  const workerStates = Array.from({ length: workerCount }, () => ({ gen: 0, islands: [[0], [0], [0], [0], [0], [0], [0], [0]] }));
  const stopAll = () => {
    workers.forEach(w => w.terminate());
  };

  const finish = (bestPlan, bestResult) => {
    try {
        const breakdown = {};
        const aminoAcids = ['cystine', 'histidine', 'isoleucine', 'leucine', 'lysine', 'methionine', 'phenylalanine', 'threonine', 'tryptophan', 'tyrosine', 'valine'];
        Object.keys(nutrientConfig).forEach(n => {
            const config = nutrientConfig[n];
            const isAmino = aminoAcids.includes(n);
            breakdown[n] = {
                amount: 0, total: 0,
                unit: isAmino ? 'g' : (n==='energy'?'kcal':n==='protein'||n==='carbs'||n==='fat'||n==='fiber'||n==='sugars'||n==='water'||n==='omega3'||n==='omega6'?'g' : ['b12','folate','a','k','selenium'].includes(n)?'mcg':'mg'),
                sources: []
            };
            Object.entries(bestPlan).forEach(([name, amount]) => {
                const food = FOOD_DATABASE.find(f => f.name === name);
                if (!food) return;
                const factor = amount / 100;
                let val = (n === 'energy' ? food.calories : n === 'protein' ? food.protein : n === 'carbs' ? food.carbs : n === 'fat' ? food.fat : (food.nutrients[n] || (n === 'fiber' ? food.nutrients['fibre'] : 0) || 0));
                let rawVal = factor * val;
                if (rawVal > 0.001) {
                    breakdown[n].amount += rawVal;
                    if (config.target > 0) {
                        breakdown[n].sources.push({ food: name, amount: Math.round((rawVal / config.target) * 100) });
                    }
                }
            });
            breakdown[n].amount = Math.round((isAmino ? breakdown[n].amount/1000 : breakdown[n].amount) * 100) / 100;
            if (config.target > 0) {
                breakdown[n].total = Math.round(((isAmino ? breakdown[n].amount * 1000 : breakdown[n].amount) / config.target) * 100);
            } else {
                breakdown[n].total = 100;
            }
        });
        
        const sectionedIngredients = {};
        Object.entries(bestPlan).forEach(([name, amount]) => {
            if (amount > 0) {
                const food = FOOD_DATABASE.find(f => f.name === name);
                if (!food) return;
                if (!sectionedIngredients[food.section]) sectionedIngredients[food.section] = [];
                sectionedIngredients[food.section].push({ name, icon: food.icon, amount: Math.round(amount), calories: Math.round((amount/100)*food.calories) });
            }
        });

        onProgress({ done: true, result: { targetCalories: Math.round(targetCalories), actualCalories: Math.round(breakdown.energy.amount), accuracy: bestResult.accuracy, macros: { protein: Math.round(breakdown.protein.amount), carbs: Math.round(breakdown.carbs.amount), fat: Math.round(breakdown.fat.amount) }, sectionedIngredients, micronutrients: breakdown } });
    } catch (e) { console.error('Finish Error: ' + e.stack); } finally { stopAll(); }
  };

  let lastProgressUpdate = 0;

  for (let i = 0; i < workerCount; i++) {
    const workerPath = path.join(__dirname, 'diet_worker.cjs');
    const worker = new Worker(workerPath, {
      workerData: {
        FOOD_DATABASE,
        details, islandCount: workerCount * islandsPerWorker, islandsPerWorker, maxGens, targetCalories, rdaScale,
        proteinTarget, fatTarget, carbTarget, essentialKeys, nutrientNames, nutrientConfig
      }
    });

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        workerStates[i] = { gen: msg.gen, islands: msg.islands };
        const now = Date.now();
        if (now - lastProgressUpdate > 150) { 
            const maxGen = Math.max(...workerStates.map(s => s.gen));
            const allIslands = workerStates.flatMap(s => s.islands || []);
            onProgress({ done: false, generation: maxGen, accuracy: msg.accuracy, telemetry: msg.telemetry });
            lastProgressUpdate = now;
        }
      } else if (msg.type === 'result') {
        completedWorkers++;
        if (!globalBest || msg.result.accuracy > globalBest.res.accuracy) {
            globalBest = { genome: msg.result.genome || {}, score: msg.result.score || 0, res: msg.result };
        }
        if (completedWorkers === workerCount) finish(globalBest.genome, globalBest.res);
      } else if (msg.type === 'migration') {
          workers.forEach((w, idx) => { if (idx !== i) w.postMessage({ type: 'import', genomes: msg.bests }); });
      }
    });

    worker.on('error', (err) => console.error(`Worker ${i} ERROR: ` + err.stack));
    workers.push(worker);
  }

  return { stop: stopAll };
}

module.exports = { generateDietAsync, FOOD_DATABASE };
