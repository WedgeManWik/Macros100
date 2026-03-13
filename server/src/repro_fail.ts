import { generateDietAsync } from './nutrition.js';

const profile = {"weight":69,"height":173,"age":23,"gender":"male","bodyFat":15,"activityLevel":1.55,"goal":"fast-lose","mealsPerDay":3,"likedFoods":["Chicken Breast","Ground Beef (5% Fat)","Salmon Fillet","Shrimp","Eggs","White Rice (Cooked)","Basmati Rice (Cooked)","Brown Rice (Cooked)","Oats (Steel Cut)","Sweet Potato (Boiled)","Potato (Boiled)","Black Beans (Cooked)","Kidney Beans (Cooked)","Banana","Apple","Blueberries","Orange","Strawberries","Raspberries","Spinach (Raw)","Broccoli (Cooked)","Carrots","Cucumber","Asparagus","Almonds","Brazil Nuts","Pistachios","Pecans","Cheddar Cheese","Almond Milk (Unsweetened)","Oat Milk (Unsweetened)","Cashew Milk (Unsweetened)","Avocado","Olive Oil","Butter","Coconut Water","Pomegranate Juice","Kefir","Dark Chocolate (85%)","Dried Apricots","Kiwi","Bell Peppers","Cashews","Mineral Water","Chicken Breast (Skinless)","Honey","Kale (Cooked)"],"mustHaveFoods":[{"name":"Eggs","min":100,"max":150},{"name":"Salmon Fillet","min":100,"max":150}],"macros":{"protein":{"mode":"g/kg","value":2.2,"strict":false},"fat":{"mode":"%","value":30,"strict":false},"carbs":{"mode":"remainder","value":0,"strict":false}},"customMacros":true,"maintenanceCalories":2537,"calorieOffset":-500,"targetCalories":2037,"customMaxAmounts":{},"algoModel":"beast","advancedSettings":false,"strictCalories":false,"customRDAs":{}};

console.log("Starting Reproduction Test for 69kg Profile (Take 2)...");

generateDietAsync(profile, (progress: any) => {
    if (progress.done) {
        console.log("FINAL PROGRESS DATA:", JSON.stringify(progress, null, 2));
        process.exit(0);
    }
});
