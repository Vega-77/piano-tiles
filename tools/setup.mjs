// One-time setup for adding songs: creates tools/.venv and installs the analyser's
// Python dependencies. Run it with `npm run setup:songs`.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { toolsFolder, venvFolder, venvPython } from './paths.mjs';

const isWindows = process.platform === 'win32';

function run(command, args) {
  return spawnSync(command, args, { stdio: 'inherit' }).status === 0;
}

function works(command, args) {
  const result = spawnSync(command, [...args, '-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']);
  return result.status === 0;
}

function findPython() {
  const candidates = isWindows
    ? [
        ['py', ['-3']],
        ['python', []],
        [join(process.env.LOCALAPPDATA ?? '', 'Programs/Python/Python313/python.exe'), []],
      ]
    : [['python3', []], ['python', []]];
  return candidates.find(([command, args]) => works(command, args));
}

if (!existsSync(venvPython)) {
  const python = findPython();
  if (!python) {
    console.error('Python 3.10+ was not found. Install it from https://www.python.org/downloads/ and run this again.');
    process.exit(1);
  }
  console.log('Creating tools/.venv ...');
  if (!run(python[0], [...python[1], '-m', 'venv', venvFolder])) process.exit(1);
}

console.log('Installing the analyser dependencies (librosa, numpy, scipy, soundfile, ffmpeg) ...');
if (!run(venvPython, ['-m', 'pip', 'install', '--quiet', '-r', join(toolsFolder, 'requirements.txt')])) process.exit(1);
console.log('Done. Start the app with `npm run dev` and drop a song onto the song list.');
