const { generateDietAsync } = require('./server/src/nutrition.cjs');

const details = {
    weight: 75,
    height: 180,
    age: 25,
    gender: 'male',
    bodyFat: 15,
    activityLevel: 1.2,
    goal: 'moderate-lose',
    likedFoods: ['Chicken Breast (Skinless)', 'Basmati Rice (Cooked)', 'Broccoli', 'Spinach (Raw)', 'Eggs', 'Banana', 'Blueberries', 'Olive Oil', 'Almonds', 'Beef Liver', 'Salmon Fillet'],
    mustHaveFoods: []
};

console.log("Starting final MILP test...");
const start = Date.now();
generateDietAsync(details, (progress) => {
    if (progress.done) {
        const end = Date.now();
        console.log("Generation complete in " + (end - start) + "ms");
        if (progress.result) {
            console.log("Accuracy: " + progress.result.accuracy + "%");
            console.log("Calories: " + progress.result.actualCalories + " (Target: " + progress.result.targetCalories + ")");
            console.log("Macros: ", progress.result.macros);
            console.log("Ingredients: ");
            Object.keys(progress.result.sectionedIngredients).forEach(s => {
                console.log(` - ${s}: ${progress.result.sectionedIngredients[s].map(f => `${f.name} (${f.amount}g)`).join(', ')}`);
            });
        } else {
            console.log("FAILED to generate diet.");
        }
        process.exit(0);
    }
});
