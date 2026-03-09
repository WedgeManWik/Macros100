const { generateDietAsync } = require('./server/src/nutrition.cjs');

const details = {"weight":110,"height":185,"age":35,"gender":"male","bodyFat":30,"activityLevel":1.375,"goal":"fast-lose","mealsPerDay":2,"likedFoods":["Ribeye Steak","Ground Beef (15% Fat)","Salmon Fillet","Pork Tenderloin","Lamb Chop","Sardines (Canned)","Duck Breast","Eggs","Bacon","Chicken Thigh (Skinless)","Avocado","Olive Oil","Butter","Cheddar Cheese","Mozzarella","Parmesan","Brie","Halloumi","Goat Cheese (Soft)","Feta Cheese","Walnuts","Brazil Nuts","Pecans","Macadamia Nuts","Pine Nuts","Spinach (Raw)","Broccoli (Cooked)","Kale (Cooked)","Cauliflower","Brussels Sprouts","Zucchini","Cucumber","Asparagus","Mushrooms","Olives (Fermented)","Black Coffee","Green Tea","Mineral Water","Kefir","Kimchi","Sauerkraut","Almonds","Pistachios","Chicken Liver","Beef Liver","Greek Yogurt","Cottage Cheese","Seaweed Snacks (Roasted)","Celery","Radish"],"mustHaveFoods":[],"macros":{"protein":{"mode":"g/kg","value":1.6},"fat":{"mode":"%","value":70},"carbs":{"mode":"remainder","value":0}},"customMacros":true,"maintenanceCalories":2796,"calorieOffset":-500,"customMaxAmounts":{}};

console.log("Starting keto 100-iteration test...");
generateDietAsync(details, (progress) => {
    if (progress.telemetry && progress.telemetry.trialInfo) console.log("Progress:", progress.telemetry.trialInfo);
    if (progress.done) {
        if (progress.result) {
            console.log("Calories: " + progress.result.actualCalories + " (Target: 2296)");
            console.log("Accuracy: " + progress.result.accuracy + "%");
            console.log("Macros: ", progress.result.macros);
            const fatCals = progress.result.macros.fat * 9;
            const totalCals = progress.result.actualCalories;
            console.log("% Calories from Fat: " + Math.round((fatCals/totalCals)*100) + "% (Target: 70%)");
        } else {
            console.log("FAILED");
        }
        process.exit(0);
    }
});
setTimeout(() => { console.log("Timed out"); process.exit(1); }, 60000);
