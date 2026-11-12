import 'mocha';
import { expect } from 'chai';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./support/temp-exit-child.ts', import.meta.url));

describe('fs temp process lifetime', function () {
  this.timeout(60000);

  it('lets a process that only resolved the temp fs exit by itself', async () => {
    const child = spawn(process.execPath, ['--no-warnings', '--loader', 'ts-node/esm', CHILD], {
      cwd: process.cwd(),
      env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.json' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let hung: NodeJS.Timeout | undefined;
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    // The grace period starts once the fs is up: ts-node startup is slow and says nothing about the timer.
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString().includes('resolved')) hung = setTimeout(() => child.kill('SIGKILL'), 5000);
    });

    const code = await exited;
    clearTimeout(hung);
    expect(code, 'the child had to be killed: a cleanup timer keeps the process alive').to.eq(0);
  });
});
