import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = join(PKG_ROOT, 'test', 'support', 'probe.fatal-exit.ts');

function probe(mode: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // LogBotstrapper installs its process handlers only outside tests.
  delete env.TESTING;
  const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-specifier-resolution=node', '--loader', 'ts-node/esm', PROBE, mode], { cwd: PKG_ROOT, encoding: 'utf8', env, timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('LogBotstrapper process handlers', function () {
  this.timeout(120000);

  it('make an app whose Configuration is invalid exit with 1 when its entry awaits the boot', () => {
    const r = probe('invalid-awaited');

    expect(r.out).to.contain('Invalid configuration');
    expect(r.out).to.not.contain('__PROBE__resolved__PROBE__');
    expect(r.status, r.out).to.equal(1);
  });

  it('make an app whose Configuration is invalid exit with 1 when its entry leaves the boot unawaited', () => {
    const r = probe('invalid-unawaited');

    expect(r.out).to.contain('Invalid configuration');
    expect(r.out).to.not.contain('__PROBE__resolved__PROBE__');
    expect(r.status, r.out).to.equal(1);
  });

  it('log an uncaught exception and keep the process running, which then exits with 1', () => {
    const r = probe('throw');

    expect(r.out).to.contain('probe uncaught exception');
    expect(r.out).to.contain('__PROBE__still-running__PROBE__');
    expect(r.status, r.out).to.equal(1);
  });
});
