import { generateDietAsync } from './nutrition.js';

const profile = {"weight":69,"height":173,"age":23,"gender":"male","bodyFat":15,"activityLevel":1.55,"goal":"maintain","mealsPerDay":3,"likedFoods":["Ground Beef (5% Fat)","Salmon Fillet","Shrimp","Eggs","Oats (Steel Cut)","Sweet Potato (Boiled)","Potato (Boiled)","Kidney Beans (Cooked)","Banana","Blueberries","Strawberries","Spinach (Raw)","Broccoli (Cooked)","Carrots","Cucumber","Almonds","Pistachios","Pecans","Cheddar Cheese","Almond Milk (Unsweetened)","Avocado","Kiwi","Bell Peppers","Cashews","Honey","Kale (Cooked)","Greek Yogurt (Non-Fat)","Greek Yogurt","Orange Juice","Apple Juice","Water","Kefir 3.5% Fat","White Rice (Cooked)","Raisins","Milk (Whole)","Milk (Semi-Skimmed)","Brazil Nuts","Apple","Raspberries","Grapes","Oat Milk (Unsweetened)","Coconut Water","Dates (Medjool)"],"mustHaveFoods":[{"name":"Eggs","min":100,"max":150},{"name":"Salmon Fillet","min":100,"max":150}],"macros":{"protein":{"mode":"g/kg","value":2.2,"strict":true},"fat":{"mode":"remainder","value":40,"strict":true},"carbs":{"mode":"g","value":30,"strict":true}},"customMacros":true,"maintenanceCalories":2537,"calorieOffset":163,"targetCalories":2700,"customMaxAmounts":{"Eggs":1000,"Kidney Beans (Cooked)":220,"Avocado":300},"algoModel":"god","advancedSettings":true,"strictCalories":true,"isBfCustom":true,"customRDAs":{}};

console.log("Starting Reproduction Test for Specific User Profile...");

generateDietAsync(profile, (progress: any) => {
    if (progress.done) {
        if (progress.result) {
            console.log("\n--- RESULT ---");
            console.log("ACCURACY:", progress.result.accuracy + "%");
            console.log("CALORIES:", progress.result.actualCalories, "/", profile.targetCalories);
            console.log("MACROS:", JSON.stringify(progress.result.macros));
            console.log("DIAGNOSTIC REASON:", progress.error);
            console.log("\nISSUES:");
            Object.entries(progress.result.micronutrients).forEach(([n, data]: [string, any]) => {
                if (data.total < 100) {
                    console.log(`- ${n.toUpperCase()} low: ${data.total}% (${data.amount.toFixed(2)} / ${data.target})`);
                }
                if (data.max && data.amount > data.max) {
                    console.log(`- ${n.toUpperCase()} high: ${Math.round(data.amount/data.max*100)}% of max (${data.amount.toFixed(2)} / ${data.max})`);
                }
            });
        } else {
            console.log("FAILED:", progress.error);
        }
        process.exit(0);
    } else {
        console.log("PROGRESS:", progress.telemetry?.trialInfo || progress.accuracy + "%");
    }
});
