import { generateDietAsync } from './nutrition.js';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';

const goals = ['fast-lose', 'moderate-lose', 'maintain', 'moderate-gain', 'fast-gain'];
const genders = ['male', 'female'];
const activityLevels = [1.2, 1.375, 1.55, 1.725, 1.9];

function getRandom(arr: any[]) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function generateRandomProfile() {
    const gender = getRandom(genders);
    const goal = getRandom(goals);
    const weight = gender === 'male' ? Math.floor(Math.random() * 50) + 70 : Math.floor(Math.random() * 40) + 50;
    const height = gender === 'male' ? Math.floor(Math.random() * 30) + 165 : Math.floor(Math.random() * 25) + 150;
    const age = Math.floor(Math.random() * 45) + 18;
    const bodyFat = gender === 'male' ? Math.floor(Math.random() * 20) + 10 : Math.floor(Math.random() * 20) + 15;
    
    // Pick 40 random liked foods
    const shuffledFoods = [...FOOD_DATABASE].sort(() => 0.5 - Math.random());
    const likedFoods = shuffledFoods.slice(0, 45).map(f => f.name);

    return {
        weight, height, age, gender, bodyFat,
        activityLevel: getRandom(activityLevels),
        goal,
        likedFoods,
        mustHaveFoods: [],
        macros: { 
            protein: { mode: "g/kg", value: 1.8 + (Math.random() * 0.6) }, 
            fat: { mode: "%", value: 20 + (Math.random() * 15) }, 
            carbs: { mode: "remainder", value: 0 } 
        },
        customMacros: true,
        maintenanceCalories: 2500, // nutrition.ts recalculates if maintenanceCalories is missing or we can provide it
        calorieOffset: goal === 'fast-lose' ? -500 : goal === 'moderate-lose' ? -250 : goal === 'moderate-gain' ? 250 : goal === 'fast-gain' ? 500 : 0,
        algoModel: 'beast',
        advancedSettings: true
    };
}

async function runTests() {
    const profiles = Array.from({ length: 20 }, () => generateRandomProfile());
    const results: any[] = [];

    console.log(`Starting bulk test for 20 diverse users...\n`);

    for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        process.stdout.write(`User ${i + 1}/20 (${p.gender}, ${p.weight}kg, ${p.goal})... `);
        
        const res: any = await new Promise((resolve) => {
            const start = Date.now();
            generateDietAsync(p, (msg: any) => {
                if (msg.done) {
                    const time = ((Date.now() - start) / 1000);
                    resolve({ 
                        accuracy: msg.result?.accuracy || 0, 
                        time, 
                        success: !!msg.result, 
                        error: msg.error,
                        calories: msg.result?.actualCalories
                    });
                }
            });
        });

        if (res.success) {
            console.log(`SUCCESS: ${res.accuracy}% (${res.calories} kcal) in ${res.time.toFixed(1)}s`);
        } else {
            console.log(`FAILED: ${res.error?.substring(0, 50)}...`);
        }
        results.push({ id: i + 1, ...res });
    }

    console.log("\n--- FINAL TEST SUMMARY ---");
    const successful = results.filter(r => r.success);
    const avgAccuracy = successful.reduce((acc, r) => acc + r.accuracy, 0) / (successful.length || 1);
    const avgTime = results.reduce((acc, r) => acc + r.time, 0) / results.length;

    console.log(`Total: 20`);
    console.log(`Success: ${successful.length}`);
    console.log(`Failed: ${20 - successful.length}`);
    console.log(`Avg Accuracy (Successes): ${avgAccuracy.toFixed(1)}%`);
    console.log(`Avg Time: ${avgTime.toFixed(1)}s`);
    
    if (20 - successful.length > 0) {
        console.log("\nFailure Reasons:");
        results.filter(r => !r.success).forEach(r => console.log(`- User ${r.id}: ${r.error}`));
    }
}

runTests();
