// Runs the analyser's self-test with the Python from `npm run setup:songs`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { toolsFolder, venvPython } from './paths.mjs';

if (!existsSync(venvPython)) {
  console.error('The song tools are not set up yet. Run `npm run setup:songs` first.');
  process.exit(1);
}
process.exit(spawnSync(venvPython, [join(toolsFolder, 'selftest.py')], { stdio: 'inherit' }).status ?? 1);
