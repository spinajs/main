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
  const run = (assertions: string, extra: { format?: 'text' | 'json' | 'github'; failOn?: 'warning' | 'error'; ir?: string; bound?: number } = {}) =>
    cmd.execute({ ir: fixture(extra.ir ?? 'authz.ir.json'), assertions: fixture(assertions), format: extra.format ?? 'text', bound: extra.bound ?? 2, failOn: extra.failOn ?? 'error' });

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

  it('fails never() of a relation and a role whose only members are public', async () => {
    for (const bound of [2, 3]) {
      for (const failOn of ['error', 'warning'] as const) {
        lines = [];
        process.exitCode = undefined;
        await run('public-members.assertions.js', { ir: 'public-members.ir.json', bound, failOn });
        expect(lines).to.deep.equal([
          'fail AZV001 never(tenant#member, tenant:enter)  violated (exact)',
          '     principal user:u1 with tenant:t1#member@user:* gets tenant:enter allow on tenant:t1',
          'fail AZV001 never(role:member, tenant:enter)    violated (exact)',
          '     principal user:u1 with tenant:t1#member@user:* gets tenant:enter allow on tenant:t1',
          '2 error(s), 0 warning(s), 0 info',
        ]);
        expect(process.exitCode, `-k ${bound} --fail-on ${failOn}`).to.equal(1);
      }
    }
  });

  it('fails never() of a role that shares its relation with a role earlier in sort order', async () => {
    for (const bound of [2, 3]) {
      lines = [];
      process.exitCode = undefined;
      await run('second-role.assertions.js', { ir: 'second-role.ir.json', bound });
      expect(lines).to.deep.equal([
        'fail AZV001 never(role:reader, doc:read)  violated (exact)',
        '     principal user:u1 with doc:d1#viewer@user:u1 gets doc:read allow on doc:d1',
        '1 error(s), 0 warning(s), 0 info',
      ]);
      expect(process.exitCode, `-k ${bound}`).to.equal(1);
    }
  });

  it('fails isolated() whose exception names a relation that holds a public group', async () => {
    for (const bound of [2, 3]) {
      for (const failOn of ['error', 'warning'] as const) {
        lines = [];
        process.exitCode = undefined;
        await run('subject-set-public.assertions.js', { ir: 'subject-set-public.ir.json', bound, failOn });
        expect(lines[0]).to.equal(`fail AZV001 isolated(tenant, except tenant#member)  violated (bounded k=${bound})`);
        expect(lines[1]).to.match(/^ {5}principal user:u1 with tenant:t\d#member@group:g\d#member, group:g\d#member@user:\* gets tenant:enter allow on tenant:t\d$/);
        expect(lines.at(-1)).to.equal('1 error(s), 0 warning(s), 0 info');
        expect(process.exitCode, `-k ${bound} --fail-on ${failOn}`).to.equal(1);
      }
    }
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
