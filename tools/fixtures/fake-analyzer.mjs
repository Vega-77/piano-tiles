// Stands in for analyze.py in the bridge tests: says what it was asked and behaves as the title says.
import { existsSync, statSync } from 'node:fs';

const [command, target, ...rest] = process.argv.slice(2);
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const flag = (name) => rest.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const title = flag('title') ?? '';

if (title === 'crash') {
  process.stderr.write('Traceback (most recent call last):\nValueError: boom\n');
  process.exit(3);
}
if (title === 'junk') {
  process.stdout.write('not json at all\n{"event":"mystery"}\n');
}
if (title === 'slow') {
  say({ event: 'stage', stage: 'wait', message: 'Thinking' });
  await new Promise((resolve) => setTimeout(resolve, 600));
}
if (title === 'refuse') {
  say({ event: 'error', message: 'That does not sound like music.' });
  process.exit(1);
}

say({ event: 'stage', stage: 'work', message: 'Working' });
const upload = command === 'import' ? { path: target, bytes: existsSync(target) ? statSync(target).size : -1 } : undefined;
say({ event: 'done', echo: { command, target: upload ? undefined : target, args: rest }, upload });
