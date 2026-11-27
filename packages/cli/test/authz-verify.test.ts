import 'mocha';
import { expect } from 'chai';
import { resolve } from 'node:path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';
import { AuthzVerifyCommand } from '../src/cli/AuthzVerify.js';
import { Cli, CommanderError } from '../src/index.js';

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

class VerifyCliConf extends VerifyConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    // Only this source folder: the merged dirs also list the built copy of this command.
    this.set(['system', 'dirs', 'cli'], [resolve(process.cwd(), 'src/cli')]);
  }
}

describe('spinajs authz:verify -k', function () {
  this.timeout(60000);

  let lines: string[];
  let cmd: AuthzVerifyCommand;
  const spinajs = async (...args: string[]) => {
    DI.register(() => ['node', 'spinajs', 'authz:verify', '--ir', fixture('authz.ir.json'), '-a', fixture('bounded.assertions.js'), ...args]).as('__cli_argv_provider__');
    await DI.resolve(Cli);
  };

  beforeEach(async () => {
    DI.clearCache();
    DI.register(VerifyCliConf).as(Configuration);
    await DI.resolve(Configuration);
    lines = [];
    cmd = await DI.resolve(AuthzVerifyCommand);
    (cmd as unknown as { Print: (l: string) => void }).Print = (l) => lines.push(l);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  /** Replaces the verifier run: a large bound must be shown to reach it without paying for it. */
  const recordBounds = () => {
    const bounds: number[] = [];
    cmd.execute = (options) => {
      bounds.push(options.bound);
      return Promise.resolve();
    };
    return bounds;
  };

  for (const k of ['0', '-1', '1.5', 'abc', '', '65', '5000000', '4294967296']) {
    it(`refuses -k '${k}' as a usage error before verifying anything`, async () => {
      const bounds = recordBounds();
      let error: unknown;
      try {
        await spinajs('-k', k);
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.equal(`CommanderError: error: option '-k, --bound <k>' argument '${k}' is invalid. The bound must be a whole number from 1 to 64.`);
      expect(error).to.be.instanceOf(CommanderError).and.include({ code: 'commander.invalidArgument', exitCode: 1 });
      expect(bounds).to.deep.equal([]);
      expect(lines).to.deep.equal([]);
      expect(process.exitCode).to.equal(undefined);
    });
  }

  it('searches one object per type with -k 1', async () => {
    await spinajs('-k', '1');
    expect(lines).to.deep.equal(['warn AZV003 isolated(folder, except public)  not decided: isolated(folder) needs k >= 2', '0 error(s), 1 warning(s), 0 info']);
    expect(process.exitCode).to.equal(undefined);
  });

  it('searches two objects per type with -k 2', async () => {
    await spinajs('-k', '2');
    expect(lines).to.deep.equal(['ok   AZV002 isolated(folder, except public)  verified up to k=2', '0 error(s), 0 warning(s), 1 info']);
  });

  it('accepts -k 64, the largest bound', async () => {
    const bounds = recordBounds();
    await spinajs('-k', '64');
    expect(bounds).to.deep.equal([64]);
  });

  it('searches three objects per type without -k', async () => {
    await spinajs();
    expect(lines).to.deep.equal(['ok   AZV002 isolated(folder, except public)  verified up to k=3', '0 error(s), 0 warning(s), 1 info']);
    expect(process.exitCode).to.equal(undefined);
  });
});
