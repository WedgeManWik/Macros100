import { generateDietAsync } from './nutrition.js';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';

const profile = {
    weight: 68, height: 173, age: 23, gender: 'male', bodyFat: 15,
    activityLevel: 1.725, goal: 'fast-lose', mealsPerDay: 3,
    likedFoods: FOOD_DATABASE.slice(0, 40).map((f: any) => f.name),
    mustHaveFoods: [],
    macros: { 
        protein: { mode: "g/kg", value: 2.2, strict: false }, 
        fat: { mode: "%", value: 30, strict: false }, 
        carbs: { mode: "remainder", value: 0, strict: false } 
    },
    customMacros: true, targetCalories: 2200, maintenanceCalories: 2700, calorieOffset: -500, customRDAs: {},
    algoModel: 'beast'
};

async function runBenchmark(label: string, config: any) {
    console.log(`\n>>> Testing: ${label}`);
    
    const customDetails = { ...profile, ...config };

    return new Promise((resolve) => {
        const start = Date.now();
        generateDietAsync(customDetails, (msg) => {
            if (msg.done) {
                const duration = ((Date.now() - start) / 1000).toFixed(1);
                if (msg.result) {
                    console.log(`Result: ${msg.result.accuracy}% in ${duration}s`);
                    resolve({ label, score: msg.result.accuracy || 0, time: duration });
                } else {
                    console.log(`Result: FAILED (${msg.error})`);
                    resolve({ label, score: 0, time: duration });
                }
            }
        });
    });
}

async function start() {
    const results = [];
    
    // Testing specific diversity seeded scenarios
    results.push(await runBenchmark("Standard Beast", { algoModel: 'beast' }));
    results.push(await runBenchmark("Olympian Diversity", { algoModel: 'olympian' }));

    console.log("\n--- BENCHMARK SUMMARY ---");
    console.table(results);
    process.exit(0);
}

start();
