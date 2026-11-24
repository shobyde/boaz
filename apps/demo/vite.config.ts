import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { boaz } from 'boaz/vite';

export default defineConfig({
  // WebLLM pulls its own chunks, so the worker has to be an ES module.
  worker: { format: 'es' },
  plugins: [
    react(),
    boaz({
      include: ['src/**/*.{ts,tsx}'],
      // The manifest is emitted into dist/ and exposed at boaz:manifest.
      fileName: 'agent-manifest.json',
    }),
  ],
});
