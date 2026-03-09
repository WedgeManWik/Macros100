const { generateDietAsync } = require('./server/src/nutrition.cjs');

const details = {"weight":75,"height":180,"age":25,"gender":"male","bodyFat":15,"activityLevel":1.375,"goal":"maintain","mealsPerDay":3,"likedFoods":["Chicken Breast","Ground Beef (5% Fat)","Salmon Fillet","Shrimp","Eggs","White Rice (Cooked)","Basmati Rice (Cooked)","Brown Rice (Cooked)","Oats (Steel Cut)","Sweet Potato (Boiled)","Potato (Boiled)","Black Beans (Cooked)","Kidney Beans (Cooked)","Banana","Apple","Blueberries","Orange","Strawberries","Raspberries","Spinach (Raw)","Broccoli (Cooked)","Carrots","Cucumber","Asparagus","Almonds","Brazil Nuts","Pistachios","Pecans","Cheddar Cheese","Almond Milk (Unsweetened)","Oat Milk (Unsweetened)","Cashew Milk (Unsweetened)","Avocado","Olive Oil","Butter","Coconut Water","Pomegranate Juice","Kefir","Dark Chocolate (85%)","Dried Apricots","Kiwi","Bell Peppers","Cashews","Mineral Water","Chicken Breast (Skinless)","Honey","Kale (Cooked)"],"mustHaveFoods":[],"macros":{"protein":{"mode":"g/kg","value":2.0},"fat":{"mode":"%","value":25},"carbs":{"mode":"remainder","value":0}},"customMacros":true,"maintenanceCalories":2500,"calorieOffset":0,"customMaxAmounts":{}};

console.log("Starting debug test...");
generateDietAsync(details, (progress) => {
    if (progress.telemetry && progress.telemetry.trialInfo) console.log("Progress:", progress.telemetry.trialInfo);
    if (progress.done) {
        if (progress.result) {
            console.log("SUCCESS");
        } else {
            console.log("FAILED (No Result)");
        }
        process.exit(0);
    }
});
setTimeout(() => { console.log("Global Timeout"); process.exit(1); }, 120000);
