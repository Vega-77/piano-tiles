// Where the song tools live, shared by setup, the self-test and the dev server.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const toolsFolder = dirname(fileURLToPath(import.meta.url));
export const analyzeScript = join(toolsFolder, 'analyze.py');
export const venvFolder = join(toolsFolder, '.venv');
export const venvPython = join(venvFolder, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
