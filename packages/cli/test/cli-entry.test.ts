import 'mocha';
import { expect } from 'chai';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../lib/cli.js', import.meta.url));

describe('the cli entry point outside an application', function () {
  this.timeout(30000);

  let cwd: string;
  const run = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'spinajs-cli-entry-'));
  });

  after(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('keeps --version working with no command to load', () => {
    const result = run('--version');
    expect(result.status, result.stderr).to.equal(0);
  });

  it('prints why it failed instead of exiting silently', () => {
    const result = run('no-such-command');
    expect(result.status).to.not.equal(0);
    expect(result.stderr).to.include('no-such-command');
  });
});
