import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/macros100/',
  build: {
    outDir: path.resolve(__dirname, '../../JanikHub/server/products/macros100'),
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': 'http://localhost:5000'
    }
  }
})
