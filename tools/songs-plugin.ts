import { join } from 'node:path';
import type { Plugin } from 'vite';
import { analyzeScript, venvPython } from './paths.mjs';
import { createSongsHandler } from './songs-bridge.ts';
import { createSongsFileHandler } from './songs-files.ts';

/**
 * Lets the app add songs while `npm run dev` runs: a song dropped on it is sent to the analyser
 * (`tools/analyze.py`), which writes it to `public/songs/`, where the dev server serves it (and the
 * build copies it, like the rest of `public/`). Not part of the build, so the published site has no
 * way in.
 */
export function songsPlugin(): Plugin {
  return {
    name: 'piano-tiles-songs',
    apply: 'serve',
    config: () => ({
      // The analyser writes to public/songs: the page tells the app itself, so the dev server needn't reload it.
      server: { watch: { ignored: ['**/public/songs/**', '**/tools/.venv/**', '**/tools/.cache/**'] } },
    }),
    configureServer(server) {
      const root = server.config.root;
      const songsFolder = join(root, 'public', 'songs');
      server.middlewares.use('/__songs', createSongsHandler({ python: venvPython, script: analyzeScript, songsFolder, cwd: root }));
      server.middlewares.use('/songs', createSongsFileHandler(songsFolder));
    },
  };
}
