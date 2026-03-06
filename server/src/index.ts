import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { FOOD_DATABASE, generateDietAsync } = require('./nutrition.cjs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// Job Store
const jobs: Record<string, any> = {};

app.get('/api/foods', (req, res) => {
  console.log(`Serving ${FOOD_DATABASE.length} foods to client`);
  res.json(FOOD_DATABASE);
});

app.post('/api/start-generation', (req, res) => {
  const jobId = Math.random().toString(36).substring(7);
  jobs[jobId] = { 
    status: 'running', 
    generation: 0, 
    maxGenerations: 4000, 
    startTime: Date.now(), 
    currentAccuracy: 0,
    result: null 
  };

  generateDietAsync(req.body, (progress: any) => {
    if (progress.done) {
        jobs[jobId].status = 'completed';
        jobs[jobId].result = progress.result;
    } else {
        jobs[jobId].generation = progress.generation;
        jobs[jobId].currentAccuracy = progress.accuracy;
        jobs[jobId].telemetry = progress.telemetry;
    }
  });

  res.json({ jobId });
});

app.get('/api/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Serve static files from React build
const buildPath = path.join(__dirname, '../../client/dist');
app.use(express.static(buildPath));

// Catch-all: serve index.html for any other requests (SPA fallback)
app.use((req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
