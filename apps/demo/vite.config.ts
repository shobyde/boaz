import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { clientAgent } from 'client-agent/vite';

export default defineConfig({
  // WebLLM pulls its own chunks, so the worker has to be an ES module.
  worker: { format: 'es' },
  plugins: [
    react(),
    clientAgent({
      include: ['src/**/*.{ts,tsx}'],
      // The manifest is emitted into dist/ and exposed at client-agent:manifest.
      fileName: 'agent-manifest.json',
    }),
  ],
});
