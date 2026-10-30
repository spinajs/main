import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('handler module load order', () => {
  it('derives an object when a handler module is loaded before derive.js', () => {
    const entry = fileURLToPath(new URL('./load-order.entry.ts', import.meta.url));
    execFileSync(process.execPath, ['--loader', 'ts-node/esm', entry], { stdio: 'pipe' });
  });
});
