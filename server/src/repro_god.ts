import { generateDietAsync } from './nutrition.js';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';

const createProfile = (mode: any) => ({
    weight: 68,
    height: 173,
    age: 23,
    gender: 'male',
    bodyFat: 15,
    activityLevel: 1.725,
    goal: 'fast-lose',
    mealsPerDay: 3,
    likedFoods: ["Chicken Breast","Ground Beef (5% Fat)","Salmon Fillet","Shrimp","Eggs","White Rice (Cooked)","Basmati Rice (Cooked)","Brown Rice (Cooked)","Oats (Steel Cut)","Sweet Potato (Boiled)","Potato (Boiled)","Black Beans (Cooked)","Kidney Beans (Cooked)","Banana","Apple","Blueberries","Orange","Strawberries","Raspberries","Spinach (Raw)","Broccoli (Cooked)","Carrots","Cucumber","Asparagus","Almonds","Brazil Nuts","Pistachios","Pecans","Cheddar Cheese","Almond Milk (Unsweetened)","Oat Milk (Unsweetened)","Cashew Milk (Unsweetened)","Avocado","Olive Oil","Butter","Coconut Water","Pomegranate Juice","Kefir","Dark Chocolate (85%)","Dried Apricots","Kiwi","Bell Peppers","Cashews","Mineral Water","Chicken Breast (Skinless)","Honey","Kale (Cooked)"],
    mustHaveFoods: [],
    macros: {
        protein: { mode: "g/kg", value: 2.2 },
        fat: { mode: "%", value: 30 },
        carbs: { mode: "remainder", value: 0 }
    },
    customMacros: true,
    maintenanceCalories: 2792,
    calorieOffset: -500,
    targetCalories: 2292,
    customMaxAmounts: {},
    algoModel: mode,
    advancedSettings: true,
    customRDAs: {}
});

async function runTest(mode: string) {
    console.log(`\n--- STARTING TEST: ${mode.toUpperCase()} MODE ---`);
    const start = Date.now();
    return new Promise((resolve) => {
        generateDietAsync(createProfile(mode), (msg) => {
            if (msg.done) {
                const duration = ((Date.now() - start) / 1000).toFixed(1);
                console.log(`\n${mode.toUpperCase()} Result: ${msg.result?.accuracy}% in ${duration}s`);
                resolve(msg.result?.accuracy);
            } else {
                process.stdout.write(`\r${mode.toUpperCase()} Progress: ${msg.generation}% | Accuracy: ${msg.accuracy}% | ${msg.telemetry?.trialInfo || ''}`);
            }
        });
    });
}

async function start() {
    await runTest('beast');
    await runTest('olympian');
    await runTest('god');
    process.exit(0);
}

start();
