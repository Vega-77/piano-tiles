/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { songsPlugin } from './tools/songs-plugin.ts';

export default defineConfig({
  // Relative asset URLs so the build works from any path (GitHub Pages serves it at /piano-tiles/).
  base: './',
  plugins: [react(), tailwindcss(), songsPlugin()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
