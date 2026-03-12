import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';
import { Food, NutrientConfig } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nutrientNames: Record<string, string> = {
    energy: 'Calories', water: 'Water', protein: 'Protein', carbs: 'Carbs', fat: 'Fat', fatSat: 'Saturated Fat', fatPoly: 'Polyunsaturated Fat', fatMono: 'Monounsaturated Fat', fatTrans: 'Trans Fat', fiber: 'Fiber', starch: 'Starch', sugars: 'Sugar', omega3: 'Omega-3', omega6: 'Omega-6', cholesterol: 'Cholesterol',
    b1: 'Vitamin B1', b2: 'Vitamin B2', b3: 'Vitamin B3', b5: 'Vitamin B5', b6: 'Vitamin B6', b12: 'Vitamin B12', folate: 'Folate', a: 'Vitamin A', c: 'Vitamin C', d: 'Vitamin D', e: 'Vitamin E', k: 'Vitamin K',
    calcium: 'Calcium', copper: 'Copper', iron: 'Iron', magnesium: 'Magnesium', manganese: 'Manganese', phosphorus: 'Phosphorus', potassium: 'Potassium', selenium: 'Selenium', sodium: 'Sodium', zinc: 'Zinc',
    iodine: 'Iodine', fluoride: 'Fluoride', caffeine: 'Caffeine', alcohol: 'Alcohol',
    cystine: 'Cystine', histidine: 'Histidine', isoleucine: 'Isoleucine', leucine: 'Leucine', lysine: 'Lysine', methionine: 'Methionine', phenylalanine: 'Phenylalanine', threonine: 'Threonine', tryptophan: 'Tryptophan', tyrosine: 'Tyrosine', valine: 'Valine'
};

export function generateDietAsync(details: any, onProgress: (msg: any) => void) {
  let targetCalories: number;
  if (details.maintenanceCalories !== undefined && details.calorieOffset !== undefined) {
    targetCalories = parseFloat(details.maintenanceCalories) + parseFloat(details.calorieOffset);
  } else {
    const lbm = details.weight * (1 - (details.bodyFat / 100));
    const bmr = 370 + (21.6 * lbm);
    const offset = details.goal === 'fast-lose' ? -500 : details.goal === 'moderate-lose' ? -250 : details.goal === 'moderate-gain' ? 250 : details.goal === 'fast-gain' ? 500 : 0;
    targetCalories = (bmr * details.activityLevel) + offset;
  }
  
  let proteinTarget = 0, fatTarget = 0, carbTarget = 0;
  
  const calcMacro = (config: any, type: string, tdee: number, weight: number) => {
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

  const isMale = details.gender === 'male';

  const nutrientConfig: Record<string, NutrientConfig> = {
    energy: { target: targetCalories, max: targetCalories + 50 },
    water: { target: isMale ? 3700 : 2700, max: 10000 },
    protein: { target: proteinTarget, essential: true, max: proteinTarget * 2 },
    carbs: { target: carbTarget, max: carbTarget * 2 },
    fat: { target: fatTarget, max: fatTarget * 2 },
    fatSat: { target: targetCalories * 0.1 / 9, essential: true, max: targetCalories * 0.15 / 9 },
    fatPoly: { target: targetCalories * 0.08 / 9, essential: true, max: targetCalories * 0.15 / 9 },
    fatMono: { target: targetCalories * 0.12 / 9, essential: true, max: targetCalories * 0.20 / 9 },
    fiber: { target: isMale ? 38 : 25, essential: true, max: 100 },
    sugars: { target: 50, max: 100 },
    omega3: { target: isMale ? 1.6 : 1.1, essential: true, max: 10 },
    omega6: { target: isMale ? 17 : 12, essential: true, max: 40 },
    cholesterol: { target: 300, essential: true, max: 600 },
    b1: { target: isMale ? 1.2 : 1.1, essential: true, max: 100 },
    b2: { target: isMale ? 1.3 : 1.1, essential: true, max: 100 },
    b3: { target: isMale ? 16 : 14, essential: true, max: 35 },
    b5: { target: 5, essential: true, max: 100 },
    b6: { target: 1.7, essential: true, max: 100 },
    b12: { target: 2.4, essential: true, max: 100 },
    folate: { target: 400, essential: true, max: 1000 },
    a: { target: isMale ? 900 : 700, essential: true, max: 3000 },
    c: { target: isMale ? 90 : 75, essential: true, max: 2000 },
    d: { target: 20, essential: true, max: 100 },
    e: { target: 15, essential: true, max: 1000 },
    k: { target: isMale ? 120 : 90, essential: true, max: 1000 },
    calcium: { target: 1000, essential: true, max: 2500 },
    copper: { target: 0.9, essential: true, max: 10 },
    iron: { target: isMale ? 8 : 18, essential: true, max: 45 },
    magnesium: { target: isMale ? 420 : 320, essential: true, max: 1000 },
    manganese: { target: isMale ? 2.3 : 1.8, essential: true, max: 11 },
    phosphorus: { target: 700, essential: true, max: 4000 },
    potassium: { target: isMale ? 3400 : 2600, essential: true, max: 10000 },
    selenium: { target: 55, essential: true, max: 400 },
    sodium: { target: 2300, essential: true, max: 3000 },
    zinc: { target: isMale ? 11 : 8, essential: true, max: 40 },
    cystine: { target: 500, essential: true, max: 5000 },
    histidine: { target: 700, essential: true, max: 5000 },
    isoleucine: { target: 1400, essential: true, max: 10000 },
    leucine: { target: 2700, essential: true, max: 20000 },
    lysine: { target: 2100, essential: true, max: 15000 },
    methionine: { target: 700, essential: true, max: 5000 },
    phenylalanine: { target: 1100, essential: true, max: 10000 },
    threonine: { target: 1000, essential: true, max: 10000 },
    tryptophan: { target: 280, essential: true, max: 2000 },
    tyrosine: { target: 800, essential: true, max: 10000 },
    valine: { target: 1600, essential: true, max: 12000 }
  };

  const essentialKeys = Object.keys(nutrientConfig).filter(k => nutrientConfig[k].essential);
  const workerCount = 1; 

  let activeWorkers: Worker[] = [];

  const stopAll = () => {
    activeWorkers.forEach(w => w.terminate());
    activeWorkers = [];
  };

  const runPhase = async (trialNum: number, label: string, seed: any = null): Promise<any> => {
    return await new Promise((resolve) => {
      let currentPhaseBest: any = null;
      let completedWorkers = 0;
      const phaseWorkers: Worker[] = [];
      const workerStates = Array.from({ length: workerCount }, () => ({ gen: 0, islands: [] }));
      let lastProgressUpdate = 0;

      for (let i = 0; i < workerCount; i++) {
        // Use .js extension for the worker path as it will be compiled
        const workerPath = path.join(__dirname, 'milp_diet_worker.js');
        const worker = new Worker(workerPath, {
          workerData: {
            FOOD_DATABASE,
            details, targetCalories,
            proteinTarget, fatTarget, carbTarget, essentialKeys, nutrientNames, nutrientConfig,
            seedGenome: seed
          }
        });
        phaseWorkers.push(worker);
        activeWorkers.push(worker);

        worker.on('message', (msg) => {
          if (msg.type === 'progress') {
            const telemetry = msg.telemetry || {};
            workerStates[i] = { gen: msg.gen || 0, islands: telemetry.islands || [] };
            
            if (telemetry.genome && Object.keys(telemetry.genome).length > 0) {
                if (!currentPhaseBest || (msg.accuracy || 0) > (currentPhaseBest.accuracy || -Infinity)) {
                    currentPhaseBest = { 
                        score: telemetry.score || 0, 
                        accuracy: msg.accuracy || 0, 
                        telemetry: telemetry, 
                        genome: telemetry.genome 
                    };
                }
            }

            const now = Date.now();
            if (now - lastProgressUpdate > 100) { 
                const allIslands = workerStates.flatMap(s => s.islands || []);
                onProgress({ 
                    done: false, 
                    generation: msg.gen || 0, 
                    accuracy: msg.accuracy || 0, 
                    telemetry: { ...(telemetry), islands: allIslands, trialInfo: telemetry.trialInfo || label } 
                });
                lastProgressUpdate = now;
            }
          } else if (msg.type === 'result') {
            completedWorkers++;
            console.log(`Worker reported result. Accuracy: \${msg.result ? msg.result.accuracy : 'N/A'}`);
            if (!currentPhaseBest || (msg.result && msg.result.accuracy > (currentPhaseBest.accuracy || -Infinity))) {
                currentPhaseBest = { genome: msg.result.genome || {}, score: msg.result.score || 0, res: msg.result, accuracy: msg.result.accuracy };
            }
            if (completedWorkers === workerCount) {
                phaseWorkers.forEach(w => w.terminate());
                activeWorkers = activeWorkers.filter(w => !phaseWorkers.includes(w));
                resolve(currentPhaseBest);
            }
          }
        });
        worker.on('error', (err: Error) => {
            console.error(`Worker Phase \${label} ERROR: ` + err.stack);
            completedWorkers++;
            if (completedWorkers === workerCount) resolve(currentPhaseBest);
        });
      }
    });
  };

  const finish = (bestPlan: any, bestResult: any) => {
    try {
        console.log("Nutrition: starting finish()");
        console.log("RAW PLAN:", JSON.stringify(bestPlan));
        const breakdown: any = {};
        const aminoAcids = ['cystine', 'histidine', 'isoleucine', 'leucine', 'lysine', 'methionine', 'phenylalanine', 'threonine', 'tryptophan', 'tyrosine', 'valine'];
        Object.keys(nutrientConfig).forEach(n => {
            const config = nutrientConfig[n];
            const isAmino = aminoAcids.includes(n);
            breakdown[n] = {
                amount: 0, total: 0,
                unit: isAmino ? 'g' : (n==='energy'?'kcal':n==='protein'||n==='carbs'||n==='fat'||n==='fiber'||n==='sugars'||n==='water'||n==='omega3'||n==='omega6'||n==='fatSat'||n==='fatPoly'||n==='fatMono'?'g' : ['b12','folate','a','k','selenium'].includes(n)?'mcg':'mg'),
                sources: []
            };
            Object.entries(bestPlan || {}).forEach(([name, amount]: [string, any]) => {
                const food = FOOD_DATABASE.find((f: Food) => f.name === name);
                if (!food) return;
                const factor = amount / 100;
                let val = (n === 'energy' ? food.calories : n === 'protein' ? food.protein : n === 'carbs' ? food.carbs : n === 'fat' ? food.fat : (food.nutrients[n] || 0));
                let rawVal = factor * val;
                if (rawVal > 0.001) {
                    breakdown[n].amount += rawVal;
                    if (config.target && config.target > 0) {
                        breakdown[n].sources.push({ food: name, amount: Math.round((rawVal / config.target) * 100) });
                    }
                }
            });
            breakdown[n].amount = Math.round((isAmino ? breakdown[n].amount/1000 : breakdown[n].amount) * 100) / 100;
            if (config.target && config.target > 0) {
                breakdown[n].total = Math.round(((isAmino ? breakdown[n].amount * 1000 : breakdown[n].amount) / config.target) * 100);
            } else {
                breakdown[n].total = 100;
            }
        });
        
        const sectionOrder = ['Proteins', 'Carbs', 'Fruits', 'Vegetables', 'Fiber and Vegetables', 'Nuts', 'Seeds', 'Fats and Oils', 'Dairy', 'Other'];
        const sectionedIngredients: any = {};
        
        // Initialize sections in correct order
        sectionOrder.forEach(s => {
            sectionedIngredients[s] = [];
        });

        Object.entries(bestPlan || {}).forEach(([name, amount]: [string, any]) => {
            if (amount > 0) {
                const food = FOOD_DATABASE.find((f: Food) => f.name === name);
                if (!food) return;
                
                const section = food.section || 'Other';
                if (!sectionedIngredients[section]) sectionedIngredients[section] = [];
                
                sectionedIngredients[section].push({ 
                    name, 
                    icon: food.icon, 
                    amount: Math.round(amount), 
                    calories: Math.round((amount/100)*food.calories) 
                });
            }
        });

        // Remove empty sections
        Object.keys(sectionedIngredients).forEach(key => {
            if (sectionedIngredients[key].length === 0) delete sectionedIngredients[key];
        });

        // ADD MINERAL WATER TO HIT TARGET
        const waterTarget = nutrientConfig.water.target || 0;
        const currentWater = breakdown.water.amount;
        if (currentWater < waterTarget) {
            const deficit = waterTarget - currentWater;
            const waterFood = FOOD_DATABASE.find((f: Food) => f.name === 'Mineral Water');
            if (waterFood) {
                const addedAmount = deficit; 
                bestPlan['Mineral Water'] = (bestPlan['Mineral Water'] || 0) + addedAmount;
                
                breakdown.water.amount += addedAmount;
                breakdown.water.total = 100;
                breakdown.water.sources.push({ food: 'Mineral Water', amount: Math.round((addedAmount / waterTarget) * 100) });
                
                const section = waterFood.section || 'Other';
                if (!sectionedIngredients[section]) sectionedIngredients[section] = [];
                const existing = sectionedIngredients[section].find((i: any) => i.name === 'Mineral Water');
                if (existing) {
                    existing.amount = Math.round(bestPlan['Mineral Water']);
                    existing.calories = Math.round((existing.amount/100)*waterFood.calories);
                } else {
                    sectionedIngredients[section].push({
                        name: 'Mineral Water',
                        icon: waterFood.icon,
                        amount: Math.round(addedAmount),
                        calories: Math.round((addedAmount/100)*waterFood.calories)
                    });
                }
            }
        }

        let totalSaturation = 0;
        essentialKeys.forEach(k => {
            totalSaturation += Math.min(1.0, breakdown[k].total / 100);
        });
        // Include water in saturation calculation
        totalSaturation += Math.min(1.0, breakdown.water.total / 100);
        
        const finalAccuracy = Math.round((totalSaturation / (essentialKeys.length + 1)) * 1000) / 10;

        console.log("Nutrition: sending final progress update (done: true)");
        onProgress({ done: true, result: { targetCalories: Math.round(targetCalories), actualCalories: Math.round(breakdown.energy.amount), accuracy: finalAccuracy, macros: { protein: Math.round(breakdown.protein.amount), carbs: Math.round(breakdown.carbs.amount), fat: Math.round(breakdown.fat.amount) }, sectionedIngredients, micronutrients: breakdown } });
    } catch (e: any) { 
        console.error('Finish Error: ' + e.stack); 
        onProgress({ done: true, result: null });
    } finally { stopAll(); }
  };

  const runAllPhases = async () => {
    try {
        onProgress({ 
            done: false, 
            generation: 0, 
            accuracy: 0, 
            telemetry: { calories: 0, fat: 0, score: 0, worstNutrient: 'Waiting...', worstPct: 0, metCount: 0, totalEssential: essentialKeys.length, islands: [], trialInfo: 'Starting MILP Solver...' } 
        });

        const trialBest = await runPhase(1, "MILP Optimization");
        if (trialBest) {
            finish(trialBest.genome, trialBest.res);
        } else {
            console.warn("MILP Solver returned no trial best.");
            onProgress({ done: true, result: null });
        }
    } catch (err) {
        console.error('Fatal Phase Error:', err);
        onProgress({ done: true, result: null });
        stopAll();
    }
  };

  runAllPhases();
  return { stop: stopAll };
}
