import { parentPort, workerData } from 'worker_threads';
// @ts-ignore
import glpkModule from 'glpk.js/node';
import { Food } from './types.js';

function log(msg: string) {
    console.log(`[MILP Worker] ${msg}`);
}

log("Worker process starting...");

process.on('uncaughtException', (err) => {
    log(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
});

const { 
  FOOD_DATABASE, details, targetCalories, 
  proteinTarget, fatTarget, carbTarget, 
  essentialKeys, nutrientNames, nutrientConfig 
} = workerData;

const foodMap = new Map<string, Food>();
FOOD_DATABASE.forEach((f: Food) => foodMap.set(f.name, f));

log("Awaiting GLPK module initialization...");
const GLPK_PROMISE = (glpkModule as any)();

async function solveGLPK(foods: Food[], isMILP: boolean) {
    const glp = await GLPK_PROMISE;
    log(`Solving ${isMILP ? 'MILP' : 'LP'} with ${foods.length} foods...`);
    
    const vars: any[] = [];
    const constraints: any[] = [];
    const binaries: string[] = [];
    const objectiveVars: any[] = [];

    // --- 1. SLACK VARIABLES (To prevent Infeasibility) ---
    // Calorie Deficit (Penalty: 10^12)
    vars.push({ name: 'cal_def', lb: 0, ub: 10000, type: glp.GLP_DB });
    objectiveVars.push({ name: 'cal_def', coef: -1000000000000 });

    // Macro Slack (Penalty: 10^9)
    ['protein', 'fat', 'carbs'].forEach(m => {
        vars.push({ name: `${m}_def`, lb: 0, ub: 1000, type: glp.GLP_DB });
        vars.push({ name: `${m}_ex`, lb: 0, ub: 1000, type: glp.GLP_DB });
        objectiveVars.push({ name: `${m}_def`, coef: -1000000000 });
        objectiveVars.push({ name: `${m}_ex`, coef: -1000000000 });
    });

    // --- 2. CORE VARIABLES ---
    vars.push({ name: 'min_coverage', lb: 0, ub: 1.0, type: glp.GLP_DB });
    objectiveVars.push({ name: 'min_coverage', coef: 10000000 });

    foods.forEach((f, i) => {
        vars.push({ name: `f_${i}`, lb: 0, ub: (f.maxAmount || 1000) / 100, type: glp.GLP_DB });
        objectiveVars.push({ name: `f_${i}`, coef: f.calories * 0.0001 }); // Small filler bonus
        if (isMILP) {
            vars.push({ name: `u_${i}`, lb: 0, ub: 1, type: glp.GLP_DB });
            binaries.push(`u_${i}`);
        }
    });

    essentialKeys.forEach((k: string) => {
        vars.push({ name: `cov_${k}`, lb: 0, ub: 1.0, type: glp.GLP_DB });
        objectiveVars.push({ name: `cov_${k}`, coef: 100000 });
    });

    // --- 3. CONSTRAINTS ---
    
    // Calories: sum(f_i * cal_i) + cal_def >= target
    constraints.push({
        name: 'cal_min',
        vars: [...foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })), { name: 'cal_def', coef: 1 }],
        bnds: { type: glp.GLP_LO, lb: targetCalories, ub: 0 }
    });
    // sum(f_i * cal_i) <= target + 50
    constraints.push({
        name: 'cal_max',
        vars: foods.map((f, i) => ({ name: `f_${i}`, coef: f.calories })),
        bnds: { type: glp.GLP_UP, lb: 0, ub: targetCalories + 50 }
    });

    // Macros: sum(f_i * macro_i) + def - ex = target
    const macroTargets = [
        { name: 'protein', val: proteinTarget },
        { name: 'fat', val: fatTarget },
        { name: 'carbs', val: carbTarget }
    ];
    macroTargets.forEach(m => {
        constraints.push({
            name: `macro_${m.name}`,
            vars: [
                ...foods.map((f, i) => ({ name: `f_${i}`, coef: (f as any)[m.name] })),
                { name: `${m.name}_def`, coef: 1 },
                { name: `${m.name}_ex`, coef: -1 }
            ],
            bnds: { type: glp.GLP_FX, lb: m.val, ub: m.val }
        });
    });

    // Nutrients
    essentialKeys.forEach((k: string) => {
        const config = nutrientConfig[k];
        const coeffList = foods.map((f, i) => {
            const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
            return { name: `f_${i}`, coef: val / (config.target || 1) };
        });

        // cov_k <= sum(f_i * val_i/target)
        constraints.push({
            name: `link_cov_${k}`,
            vars: [...coeffList, { name: `cov_${k}`, coef: -1 }],
            bnds: { type: glp.GLP_LO, lb: 0, ub: 0 }
        });

        // min_coverage <= cov_k
        constraints.push({
            name: `link_min_${k}`,
            vars: [{ name: 'min_coverage', coef: 1 }, { name: `cov_${k}`, coef: -1 }],
            bnds: { type: glp.GLP_UP, lb: 0, ub: 0 }
        });

        if (config.max) {
            constraints.push({
                name: `max_${k}`,
                vars: foods.map((f, i) => {
                    const val = (k === 'energy' ? f.calories : k === 'protein' ? f.protein : k === 'carbs' ? f.carbs : k === 'fat' ? f.fat : (f.nutrients[k] as any || 0));
                    return { name: `f_${i}`, coef: val };
                }),
                bnds: { type: glp.GLP_UP, lb: 0, ub: config.max }
            });
        }
    });

    if (isMILP) {
        foods.forEach((f, i) => {
            const minVal = (f.minAmount || 0) / 100;
            const maxVal = (f.maxAmount || 1000) / 100;
            constraints.push({
                name: `min_bound_${i}`,
                vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -minVal }],
                bnds: { type: glp.GLP_LO, lb: 0, ub: 0 }
            });
            constraints.push({
                name: `max_bound_${i}`,
                vars: [{ name: `f_${i}`, coef: 1 }, { name: `u_${i}`, coef: -maxVal }],
                bnds: { type: glp.GLP_UP, lb: 0, ub: 0 }
            });
            const mustHave = details.mustHaveFoods?.find((m: any) => m.name === f.name);
            if (mustHave) {
                constraints.push({ name: `force_${i}`, vars: [{ name: `u_${i}`, coef: 1 }], bnds: { type: glp.GLP_FX, lb: 1, ub: 1 } });
            }
        });
    }

    const res = await glp.solve({
        name: 'DietPlanner',
        objective: { direction: glp.GLP_MAX, name: 'score', vars: objectiveVars },
        subjectTo: constraints,
        bounds: vars,
        binaries: binaries,
        options: { presol: true }
    });

    return res;
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
                if (totals[n] !== undefined) totals[n] += r * (f.nutrients[n] || 0);
            }
        }
    }
    let metCount = 0;
    let worst = { key: '', pct: 1.0 };
    essentialKeys.forEach((k: string) => {
        const pct = totals[k] / (nutrientConfig[k].target || 1);
        if (pct >= 0.95) metCount++;
        if (pct < worst.pct) worst = { key: k, pct };
    });
    return { accuracy: Math.round((metCount / essentialKeys.length) * 1000) / 10, totals, genome, worst };
}

async function run() {
    log("Starting run()...");
    const totalTimeout = setTimeout(() => {
        log("Worker Global Safety Timeout Triggered!");
        parentPort?.postMessage({ type: 'result', result: null });
        process.exit(1);
    }, 60000);

    try {
        const likedFoods = FOOD_DATABASE.filter((f: Food) => {
            const liked = details.likedFoods || [];
            if (liked.length === 0) return true;
            const nameLower = f.name.toLowerCase();
            return liked.some((l: string) => {
                const lLower = l.toLowerCase();
                if (nameLower === lLower) return true;
                const regex = new RegExp(`\\b${lLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                return regex.test(nameLower);
            });
        });
        log(`Pool size: ${likedFoods.length} foods.`);

        parentPort?.postMessage({ type: 'progress', gen: 10, accuracy: 0, telemetry: { trialInfo: "Pass 1: Identifying Gaps..." } });
        const res1 = await solveGLPK(likedFoods, false);
        
        let currentBestGenome: Record<string, number> = {};
        if (res1.result.vars) {
            likedFoods.forEach((f: Food, i: number) => {
                const val = res1.result.vars[`f_${i}`] || 0;
                if (val > 0.001) currentBestGenome[f.name] = Math.round(val * 100);
            });
        }
        
        const eval1 = evaluateDiet(currentBestGenome);
        log(`Pass 1 accuracy: ${eval1.accuracy}%`);
        
        parentPort?.postMessage({ type: 'progress', gen: 30, accuracy: eval1.accuracy, telemetry: { trialInfo: "Pass 2: Dynamic Selection..." } });
        const specialists = new Set<string>();
        essentialKeys.forEach((k: string) => {
            const pct = (eval1.totals[k] || 0) / (nutrientConfig[k].target || 1);
            if (pct < 0.98) {
                const candidates = [...FOOD_DATABASE].sort((a, b) => {
                    const getVal = (food: Food) => {
                        if (k === 'energy') return food.calories;
                        if (k === 'protein') return food.protein;
                        if (k === 'carbs') return food.carbs;
                        if (k === 'fat') return food.fat;
                        return (food.nutrients[k] as any) || 0;
                    };
                    return (getVal(b) / (b.calories || 1)) - (getVal(a) / (a.calories || 1));
                });
                for (let i = 0; i < 3; i++) if (candidates[i]) specialists.add(candidates[i].name);
            }
        });
        log(`Found ${specialists.size} specialist foods.`);

        const elitePoolNames = new Set([...Object.keys(currentBestGenome), ...Array.from(specialists)]);
        const elitePool = FOOD_DATABASE.filter((f: Food) => elitePoolNames.has(f.name));
        log(`Elite pool size: ${elitePool.length} foods.`);

        parentPort?.postMessage({ type: 'progress', gen: 60, accuracy: eval1.accuracy, telemetry: { trialInfo: `Pass 3: Final MILP (${elitePool.length} foods)...` } });
        const res2 = await solveGLPK(elitePool, true);
        
        if (res2.result.vars) {
            const finalGenome: Record<string, number> = {};
            elitePool.forEach((f: Food, i: number) => {
                const val = res2.result.vars[`f_${i}`] || 0;
                if (val > 0.001) finalGenome[f.name] = Math.round(val * 100);
            });
            currentBestGenome = finalGenome;
        }

        const finalEval = evaluateDiet(currentBestGenome);
        log(`Final accuracy: ${finalEval.accuracy}%, Calories: ${finalEval.totals.energy}`);

        clearTimeout(totalTimeout);
        parentPort?.postMessage({ 
            type: 'result', 
            result: {
                genome: finalEval.genome,
                targetCalories,
                actualCalories: Math.round(finalEval.totals.energy),
                accuracy: finalEval.accuracy,
                macros: { protein: Math.round(finalEval.totals.protein), carbs: Math.round(finalEval.totals.carbs), fat: Math.round(finalEval.totals.fat) }
            }
        });
    } catch (err: any) {
        log(`FATAL ERROR IN RUN: ${err.message}\n${err.stack}`);
        clearTimeout(totalTimeout);
        parentPort?.postMessage({ type: 'result', result: null });
    }
}

run();
