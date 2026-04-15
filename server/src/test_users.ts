import { generateDietAsync } from './nutrition.js';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';

const profiles = [
    { weight: 70, height: 175, age: 25, gender: 'male', bodyFat: 15, activityLevel: 1.55, goal: 'fast-lose', mealsPerDay: 3 },
    { weight: 60, height: 165, age: 30, gender: 'female', bodyFat: 20, activityLevel: 1.2, goal: 'moderate-lose', mealsPerDay: 3 },
    { weight: 85, height: 180, age: 35, gender: 'male', bodyFat: 25, activityLevel: 1.375, goal: 'moderate-gain', mealsPerDay: 4 },
    { weight: 55, height: 160, age: 22, gender: 'female', bodyFat: 18, activityLevel: 1.725, goal: 'fast-gain', mealsPerDay: 5 },
    { weight: 75, height: 170, age: 40, gender: 'male', bodyFat: 18, activityLevel: 1.465, goal: 'moderate-lose', mealsPerDay: 3 },
    { weight: 65, height: 168, age: 28, gender: 'female', bodyFat: 22, activityLevel: 1.55, goal: 'moderate-gain', mealsPerDay: 3 },
    { weight: 95, height: 190, age: 50, gender: 'male', bodyFat: 20, activityLevel: 1.2, goal: 'fast-lose', mealsPerDay: 2 },
    { weight: 50, height: 155, age: 20, gender: 'female', bodyFat: 15, activityLevel: 1.9, goal: 'fast-gain', mealsPerDay: 4 },
    { weight: 80, height: 178, age: 33, gender: 'male', bodyFat: 15, activityLevel: 1.55, goal: 'moderate-gain', mealsPerDay: 3 },
    { weight: 70, height: 165, age: 45, gender: 'female', bodyFat: 25, activityLevel: 1.375, goal: 'moderate-lose', mealsPerDay: 3 }
].map(p => ({
    ...p,
    likedFoods: FOOD_DATABASE.slice(0, 30).map((f: any) => f.name),
    mustHaveFoods: [],
    macros: { protein: { mode: "g/kg", value: 2.0 }, fat: { mode: "%", value: 30 }, carbs: { mode: "remainder", value: 0 } },
    customMacros: true,
    maintenanceCalories: 2500,
    calorieOffset: p.goal === 'fast-lose' ? -500 : p.goal === 'moderate-lose' ? -250 : p.goal === 'moderate-gain' ? 250 : 500,
    algoModel: 'beast',
    advancedSettings: true
}));

async function runTests() {
    for (let i = 0; i < profiles.length; i++) {
        console.log(`\n--- TEST USER ${i + 1} (${profiles[i].goal}) ---`);
        await new Promise((resolve) => {
            const start = Date.now();
            generateDietAsync(profiles[i], (msg: any) => {
                if (msg.done) {
                    const time = ((Date.now() - start) / 1000).toFixed(1);
                    if (msg.result) console.log(`SUCCESS: ${msg.result.accuracy}% accuracy in ${time}s`);
                    else console.log(`FAILED: ${msg.error || 'Unknown error'} | ${JSON.stringify(msg)}`);
                    resolve(null);
                }
            });
        });
    }
}

runTests();
