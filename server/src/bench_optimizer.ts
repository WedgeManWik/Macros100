import { generateDietAsync } from './nutrition.js';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';

const profile = {
    weight: 68, height: 173, age: 23, gender: 'male', bodyFat: 15,
    activityLevel: 1.725, goal: 'fast-lose', mealsPerDay: 3,
    likedFoods: ["Chicken Breast","Ground Beef (5% Fat)","Salmon Fillet","Shrimp","Eggs","White Rice (Cooked)","Basmati Rice (Cooked)","Brown Rice (Cooked)","Oats (Steel Cut)","Sweet Potato (Boiled)","Potato (Boiled)","Black Beans (Cooked)","Kidney Beans (Cooked)","Banana","Apple","Blueberries","Orange","Strawberries","Raspberries","Spinach (Raw)","Broccoli (Cooked)","Carrots","Cucumber","Asparagus","Almonds","Brazil Nuts","Pistachios","Pecans","Cheddar Cheese","Almond Milk (Unsweetened)","Oat Milk (Unsweetened)","Cashew Milk (Unsweetened)","Avocado","Olive Oil","Butter","Coconut Water","Pomegranate Juice","Kefir","Dark Chocolate (85%)","Dried Apricots","Kiwi","Bell Peppers","Cashews","Mineral Water","Chicken Breast (Skinless)","Honey","Kale (Cooked)"],
    mustHaveFoods: [],
    macros: { protein: { mode: "g/kg", value: 2.2 }, fat: { mode: "%", value: 30 }, carbs: { mode: "remainder", value: 0 } },
    customMacros: true, targetCalories: 2292, maintenanceCalories: 2792, calorieOffset: -500, customRDAs: {}
};

async function runBenchmark(specs: number, subset: number, trials: number, refinements: number) {
    const label = `S:${specs}|Sub:${subset}|T:${trials}|R:${refinements}`;
    console.log(`\n>>> Testing: ${label}`);
    
    // We override the worker logic temporarily by passing these values in details
    const customDetails = { ...profile, benchConfig: { specs, subset, trials, refinements } };

    return new Promise((resolve) => {
        const start = Date.now();
        generateDietAsync(customDetails, (msg) => {
            if (msg.done) {
                const duration = ((Date.now() - start) / 1000).toFixed(1);
                console.log(`Result: ${msg.result?.accuracy}% in ${duration}s`);
                resolve({ label, score: msg.result?.accuracy || 0, time: duration });
            }
        });
    });
}

async function start() {
    const results = [];
    
    // Matrix of possibilities to find the sweet spot
    const configs = [
        { s: 5, sub: 25, t: 500, r: 5 },   // Ultra Lean
        { s: 10, sub: 30, t: 1000, r: 10 }, // Current Beast
        { s: 15, sub: 35, t: 2000, r: 15 }, // Mid Range
        { s: 20, sub: 40, t: 5000, r: 20 }, // High Range
        { s: 10, sub: 45, t: 5000, r: 10 }  // Wide but few refinements
    ];

    for (const c of configs) {
        results.push(await runBenchmark(c.s, c.sub, c.t, c.r));
    }

    console.log("\n--- BENCHMARK SUMMARY ---");
    console.table(results);
    process.exit(0);
}

start();
