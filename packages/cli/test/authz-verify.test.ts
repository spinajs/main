import 'mocha';
import { expect } from 'chai';
import { resolve } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { AuthzVerifyCommand } from '../src/cli/AuthzVerify.js';

const fixture = (name: string) => resolve(process.cwd(), 'test/fixtures/authz-verify', name);

class VerifyConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

describe('spinajs authz:verify', function () {
  this.timeout(60000);

  let lines: string[];
  let cmd: AuthzVerifyCommand;
  const run = (assertions: string, extra: { format?: 'text' | 'json' | 'github'; failOn?: 'warning' | 'error' } = {}) =>
    cmd.execute({ ir: fixture('authz.ir.json'), assertions: fixture(assertions), format: extra.format ?? 'text', bound: 2, failOn: extra.failOn ?? 'error' });

  beforeEach(async () => {
    DI.clearCache();
    DI.register(VerifyConf).as(Configuration);
    await DI.resolve(Configuration);
    lines = [];
    cmd = await DI.resolve(AuthzVerifyCommand);
    (cmd as unknown as { Print: (l: string) => void }).Print = (l) => lines.push(l);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('prints holding assertions and leaves the exit code unset', async () => {
    await run('holds.assertions.js');
    expect(lines).to.deep.equal(['ok   AZV002 implies(folder:update, folder:read)  holds (exact)', 'ok   AZV002 never(public, *:update)              holds (exact)', '0 error(s), 0 warning(s), 2 info']);
    expect(process.exitCode).to.equal(undefined);
  });

  it('prints a violated assertion with its counterexample and sets exit code 1', async () => {
    await run('violated.assertions.js');
    expect(lines[0]).to.equal('fail AZV001 never(public, folder:read)  violated (exact)');
    expect(lines[1]).to.equal('     principal user:u1 with folder:f1#viewer@user:* gets folder:read allow on folder:f1');
    expect(process.exitCode).to.equal(1);
  });

  it('prints one json line', async () => {
    await run('violated.assertions.js', { format: 'json' });
    expect(lines).to.have.length(1);
    expect((JSON.parse(lines[0]) as { summary: { error: number } }).summary.error).to.equal(1);
  });

  it('refuses a module whose default export is not an assertion set', async () => {
    let error: unknown;
    try {
      await run('not-a-set.js');
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).to.match(/must export defineAssertions/);
  });
});
