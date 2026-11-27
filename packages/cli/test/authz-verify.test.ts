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
  const run = (assertions: string, extra: { format?: 'text' | 'json' | 'github'; failOn?: 'warning' | 'error' | 'bounded'; ir?: string; bound?: number } = {}) =>
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

  describe('a holds that only the bounded engine found', () => {
    const fixtures = [
      { ir: 'bounded-closed.ir.json', assertions: 'bounded-holds.assertions.js', control: [], summary: '0 error(s), 2 warning(s), 0 info' },
      { ir: 'bounded-intersect.ir.json', assertions: 'bounded-holds-control.assertions.js', control: ['ok   AZV002 never(public, tenant:enter)             holds (exact)'], summary: '0 error(s), 2 warning(s), 1 info' },
    ];

    it('prints a warning with AZV007 and leaves the default exit code unset', async () => {
      for (const f of fixtures) {
        for (const bound of [2, 3]) {
          lines = [];
          process.exitCode = undefined;
          await run(f.assertions, { ir: f.ir, bound });
          expect(lines, `${f.ir} -k ${bound}`).to.deep.equal([
            `warn AZV007 never(role:other, tenant:enter)         holds only up to k=${bound} (not proven)`,
            `warn AZV007 never(role:other@tenant, tenant:enter)  holds only up to k=${bound} (not proven)`,
            ...f.control,
            f.summary,
          ]);
          expect(process.exitCode, `${f.ir} -k ${bound}`).to.equal(undefined);
        }
      }
    });

    it('fails under --fail-on bounded and --fail-on warning', async () => {
      for (const f of fixtures) {
        for (const bound of [2, 3]) {
          for (const failOn of ['bounded', 'warning'] as const) {
            process.exitCode = undefined;
            await run(f.assertions, { ir: f.ir, bound, failOn });
            expect(process.exitCode, `${f.ir} -k ${bound} --fail-on ${failOn}`).to.equal(1);
          }
        }
      }
    });

    it('carries AZV007 in the json and github output in the shape of every diagnostic', async () => {
      await run('bounded-holds.assertions.js', { ir: 'bounded-closed.ir.json', format: 'json' });
      const json = JSON.parse(lines[0]) as { results: { diagnostics: unknown[] }[]; summary: unknown };
      expect(json.results.map((r) => r.diagnostics)).to.deep.equal([
        [{ code: 'AZV007', severity: 'warning', assertion: 'never(role:other, tenant:enter)', message: 'holds only up to k=2 (not proven)' }],
        [{ code: 'AZV007', severity: 'warning', assertion: 'never(role:other@tenant, tenant:enter)', message: 'holds only up to k=2 (not proven)' }],
      ]);
      expect(json.summary).to.deep.equal({ error: 0, warning: 2, info: 0 });
      lines = [];
      await run('bounded-holds.assertions.js', { ir: 'bounded-closed.ir.json', format: 'github' });
      expect(lines[0]).to.equal('::warning title=AZV007 never(role%3Aother%2C tenant%3Aenter)::holds only up to k=2 (not proven)');
    });
  });

  it('--fail-on bounded fails on an error and on no warning other than AZV007', async () => {
    const cases = [
      { assertions: 'opaque.assertions.js', ir: 'opaque.ir.json', exit: undefined },
      { assertions: 'holds.assertions.js', ir: 'authz.ir.json', exit: undefined },
      { assertions: 'violated.assertions.js', ir: 'authz.ir.json', exit: 1 },
    ];
    for (const c of cases) {
      lines = [];
      process.exitCode = undefined;
      await run(c.assertions, { ir: c.ir, failOn: 'bounded' });
      expect(process.exitCode, c.assertions).to.equal(c.exit);
    }
    lines = [];
    process.exitCode = undefined;
    await run('opaque.assertions.js', { ir: 'opaque.ir.json', failOn: 'warning' });
    expect(lines).to.deep.equal(['ok   AZV002 never(public, tenant:enter)  holds (exact)', "warn AZV003 never(public, tenant:enter)  depends on opaque: model 'legacy'", '0 error(s), 1 warning(s), 1 info']);
    expect(process.exitCode).to.equal(1);
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
