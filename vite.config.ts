/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Relative asset URLs so the build works from any path (GitHub Pages serves it at /piano-tiles/).
  base: './',
  plugins: [react(), tailwindcss()],
  // The song analyser runs in a module worker (see src/songs/analysis/client.ts).
  worker: { format: 'es' },
  // (The one chunk over the default limit is Firestore, which is only loaded once someone signs in.)
  build: { chunkSizeWarningLimit: 600 },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
