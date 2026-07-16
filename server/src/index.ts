import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import Groq from 'groq-sdk';
// @ts-ignore
import { FOOD_DATABASE } from './foods.cjs';
import { generateDietAsync } from './nutrition.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));
app.use(bodyParser.json());

// Job Store
const jobs: Record<string, any> = {};

app.get('/api/foods', (req, res) => {
  console.log(`Serving ${FOOD_DATABASE.length} foods to client`);
  res.json(FOOD_DATABASE);
});

app.post('/api/start-generation', (req, res) => {
  const algoModel = req.body.algoModel || 'NOT SPECIFIED';
  const jobId = Math.random().toString(36).substring(7);
  console.log(`[Server][Job ${jobId}] Received generation request. Model: ${algoModel}`);
  console.log(`[Server][Job ${jobId}] Starting generation...`);
  
  jobs[jobId] = { 
    status: 'running', 
    generation: 0, 
    maxGenerations: 1, 
    startTime: Date.now(), 
    currentAccuracy: 0,
    result: null 
  };

  try {
    const generator = generateDietAsync(req.body, (progress: any) => {
      try {
        if (progress.done) {
            console.log(`[Server][Job ${jobId}] Finished. Success: ${!!progress.result}. Error: ${progress.error || 'None'}`);
            jobs[jobId].status = progress.result ? 'completed' : 'failed';
            jobs[jobId].result = progress.result;
            if (progress.error) jobs[jobId].error = progress.error;
        } else {
            jobs[jobId].generation = progress.generation;
            jobs[jobId].currentAccuracy = progress.accuracy;
            jobs[jobId].telemetry = progress.telemetry;
        }
      } catch (err: any) {
        console.error(`[Server][Job ${jobId}] Error in progress callback: ${err.message}`);
      }
    });
    jobs[jobId].stop = generator.stop;
  } catch (err: any) {
    console.error(`[Server][Job ${jobId}] Failed to start generation: ${err.message}`);
    jobs[jobId].status = 'failed';
    jobs[jobId].error = err.message;
  }

  res.json({ jobId });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/api/cancel-generation/:id', (req, res) => {
  const jobId = req.params.id;
  const job = jobs[jobId];
  if (job) {
    console.log(`[Server][Job ${jobId}] Received cancel request. Terminating worker...`);
    if (typeof job.stop === 'function') {
      try {
        job.stop();
      } catch (err: any) {
        console.error(`[Server][Job ${jobId}] Error calling stop(): ${err.message}`);
      }
    }
    job.status = 'cancelled';
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

app.post('/api/generate-meal-plan', async (req, res) => {
  try {
    const { ingredients, customInstructions, previousPlan } = req.body;
    if (!ingredients || !Array.isArray(ingredients)) {
      return res.status(400).json({ error: 'Ingredients array is required' });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server' });
    }

    const groq = new Groq({ apiKey });

    let prompt = `You are an expert, world-class nutritionist and chef. 
I have a list of ingredients and their EXACT portions that perfectly match my daily macro and calorie goals. 
I need you to organize these exact ingredients into a logical, delicious full-day meal plan (e.g., Breakfast, Lunch, Dinner, Snacks).

CRITICAL RULES:
1. You MUST use EVERY ingredient on the list.
2. You MUST use the EXACT gram amounts provided. Do not change the quantities.
3. You MUST NOT add any new ingredients, not even spices, oils, or water unless they are in the list.
4. If an ingredient doesn't fit neatly into a traditional meal, combine it creatively or list it as a snack.
5. Format your response beautifully using Markdown. Use bold headings for meals.
6. Keep descriptions brief and appetizing.
7. EXACT FORMAT REQUIRED for each meal:
   ### [Meal Name]
   - [Amount]g of [Ingredient]
   - [Amount]g of [Ingredient]
   
   [Brief, appetizing 1-sentence description]

Here is the daily ingredient list:
${ingredients.map((i: any) => `- ${i.grams}g of ${i.name}`).join('\n')}
`;

    if (previousPlan) {
      prompt += `\nHere is the CURRENT MEAL PLAN:\n${previousPlan}\n`;
      prompt += `\nThe user has manually edited this plan or requested changes. Please generate a NEW meal plan that incorporates their instructions while preserving their edits as much as possible, and STRICTLY adhering to the exact format and ingredient rules above.\n`;
    }

    if (customInstructions && customInstructions.trim().length > 0) {
      prompt += `\nUSER CUSTOM INSTRUCTIONS:\n${customInstructions}\n`;
    }

    prompt += `\nGenerate the meal plan now:`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'user', content: prompt }],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
    });

    const text = chatCompletion.choices[0]?.message?.content || 'Failed to generate meal plan.';

    res.json({ mealPlan: text });
  } catch (err: any) {
    console.error('Error generating meal plan:', err);
    res.status(500).json({ error: 'Failed to generate meal plan', details: err.message });
  }
});

// Serve static files from React build (Optional for split deployments)
if (process.env.SERVE_FRONTEND !== 'false') {
  const buildPath = path.join(__dirname, '../../client/dist');
  console.log(`Checking for static files at: ${buildPath}`);

  app.use(express.static(buildPath));

  // Catch-all: serve index.html for any other requests (SPA fallback)
  app.use((req, res) => {
    const indexPath = path.join(buildPath, 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err) {
        if (!res.headersSent) {
          console.error(`Error sending index.html: ${err.message} at ${indexPath}`);
          res.status(404).send('Frontend build not found. Please check deployment logs.');
        }
      }
    });
  });
}

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
