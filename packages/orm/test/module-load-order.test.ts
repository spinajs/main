import { expect } from 'chai';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

// A mocha run shares one module graph, so only a fresh process shows what loading a module first does.
function importFirst(module: string): Promise<{ code: number | null; output: string }> {
  const url = new URL(`../src/${module}`, import.meta.url).href;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-specifier-resolution=node', '--loader', 'ts-node/esm', '--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, TS_NODE_PROJECT: `${PACKAGE_DIR}tsconfig.json` },
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('orm modules load as the first module of a process', function () {
  this.timeout(90_000);

  for (const module of ['migration-runner.ts', 'migrator.ts', 'migration-guard.ts', 'index.ts']) {
    it(module, async () => {
      const r = await importFirst(module);
      expect(r.code, r.output).to.eq(0);
    });
  }
});
