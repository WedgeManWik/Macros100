import { generateDietAsync } from './nutrition.js';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';

const details = {
    weight: 68,
    height: 173,
    age: 23,
    gender: 'male',
    bodyFat: 15,
    activityLevel: 1.55,
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
    maintenanceCalories: 2509,
    calorieOffset: -500,
    targetCalories: 2009,
    customMaxAmounts: {},
    algoModel: 'god'
};

console.log("Starting God Mode Simulation...");

generateDietAsync(details, (msg) => {
    if (msg.done) {
        if (msg.result) {
            console.log("\n--- SIMULATION COMPLETED ---");
            console.log("Saturation Score:", msg.result.accuracy + "%");
            console.log("Calories:", msg.result.actualCalories);
            console.log("Protein:", msg.result.macros.protein + "g");
            console.log("Carbs:", msg.result.macros.carbs + "g");
            console.log("Fat:", msg.result.macros.fat + "g");
            const items = Object.values(msg.result.sectionedIngredients).flat();
            console.log("Ingredients:", (items as any[]).map(i => `${i.name} (${i.amount}g)`).join(", "));
        } else {
            console.log("\n--- SIMULATION FAILED ---");
        }
        process.exit(0);
    } else {
        if (msg.telemetry?.trialInfo?.includes("Refining")) {
             process.stdout.write(`\rProgress: ${msg.generation}% | ${msg.telemetry.trialInfo}`);
        }
    }
});
