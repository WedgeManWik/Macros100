import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
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
