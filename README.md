# Macros100 - Precision AI Nutrition

An unscrambled, production-ready version of the AI Diet Planner.

## Project Structure

- `/client`: React + Vite + TypeScript frontend.
- `/server`: Express + TypeScript backend + Worker Threads.

## How to Run

### 1. Install Dependencies

In the root folder, run:
```bash
cd client && npm install
cd ../server && npm install
```

### 2. Development

Start the server:
```bash
cd server && npm run dev
```

Start the client (in a new terminal):
```bash
cd client && npm run dev
```

The client is configured to proxy `/api` requests to the server at `http://localhost:5000`.

### 3. Production Build

To host this online:

1. Build the client:
   ```bash
   cd client && npm run build
   ```
2. Build the server:
   ```bash
   cd server && npm run build
   ```
3. Start the production server:
   ```bash
   cd server && npm start
   ```

The server will automatically serve the built client files from `client/dist`.

## Optimization Engine

The core optimization is handled by `server/src/diet_worker.ts` using Node.js `worker_threads` for parallel processing, ensuring the main thread remains responsive.
