import { join, normalize, resolve } from 'path';
import { expect } from 'chai';
import { restore, spy } from 'sinon';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { createTestApp, disposeTestApps, sourceRef, testManifest, withManifest } from '@spinajs/testing';
import '@spinajs/log';
import { Cli, CliCommandHook } from '../src/index.js';
import type { CliHookCommand, IOption } from '../src/index.js';
import { TestCommand } from './commands/TestCommand.js';
import { TestFailingResolveCommand } from './commands/TestFailingResolveCommand.js';

const commands = resolve(normalize(join(process.cwd(), 'test', 'commands')));
const seen: Array<{ hook: string; command: string; options: Readonly<Record<string, unknown>> }> = [];
let hooking = false;

const logging = {
  logger: {
    targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '${message}' }],
    rules: [{ name: '*', level: 'trace', target: 'Empty' }],
  },
};

class HookConf extends FrameworkConfiguration {
  // Merged, the dirs list every workspace package's commands; only the test commands stay.
  public async resolve(): Promise<void> {
    await super.resolve();
    this.set(['system', 'dirs', 'cli'], [commands]);
  }

  protected onLoad() {
    return { ...logging, system: { dirs: { cli: [commands] } } };
  }
}

// DI keeps a registration for the rest of the process: switched off, a probe adds no option and only calls next().
class OuterProbe extends CliCommandHook {
  public override readonly order: number = -10;

  public override options(): readonly IOption[] {
    return hooking ? [{ flags: '--zone <name>', description: 'an option every command accepts' }] : [];
  }

  public async aroundExecute<T>(command: CliHookCommand, next: () => Promise<T>): Promise<T> {
    if (hooking) seen.push({ hook: 'outer', command: command.name, options: command.options });
    return next();
  }
}

class InnerProbe extends CliCommandHook {
  public async aroundExecute<T>(command: CliHookCommand, next: () => Promise<T>): Promise<T> {
    if (hooking) {
      seen.push({ hook: 'inner', command: command.name, options: command.options });
      if (command.options.zone === 'closed') throw new Error('zone closed');
    }
    return next();
  }
}

DI.register(InnerProbe).as(CliCommandHook);
DI.register(OuterProbe).as(CliCommandHook);

const outcome = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'ran',
    (err: unknown) => err,
  );

async function run(argv: string[]): Promise<unknown> {
  DI.clearCache();
  DI.register(HookConf).as(Configuration);
  await DI.resolve(Configuration);
  DI.register(() => ['node', 'script.js', ...argv]).as('__cli_argv_provider__');
  return outcome(Promise.resolve(DI.resolve(Cli)));
}

describe('CliCommandHook', function () {
  // every run merges the configuration of all workspace packages, about a second
  this.timeout(20000);

  beforeEach(() => {
    DI.setESMModuleSupport();
    seen.length = 0;
  });

  afterEach(async () => {
    hooking = false;
    restore();
    await disposeTestApps();
  });

  it('runs a command as before when no hook acts, and knows no option a hook would add', async () => {
    const execute = spy(TestCommand.prototype, 'execute');

    expect(await run(['test-command', 'login', 'password', '-t', '10000'])).to.eq('ran');
    expect(execute.calledOnce).to.eq(true);
    expect(execute.args[0]).to.have.length(4);
    expect(seen).to.deep.eq([]);
    // -t is given because the command requires it: only the unknown option can refuse this run
    expect(await run(['test-command', 'login', 'password', '-t', '10000', '--zone', 'eu'])).to.be.instanceOf(Error);
  });

  it('wraps the action, the lowest order outermost, and passes global options given after or before the command', async () => {
    hooking = true;
    const execute = spy(TestCommand.prototype, 'execute');

    expect(await run(['test-command', 'login', 'password', '-t', '10000', '--zone', 'eu'])).to.eq('ran');
    expect(await run(['--zone', 'us', 'test-command', 'login', 'password', '-t', '10000'])).to.eq('ran');

    expect(seen.map((s) => [s.hook, s.command, s.options.zone])).to.deep.eq([
      ['outer', 'test-command', 'eu'],
      ['inner', 'test-command', 'eu'],
      ['outer', 'test-command', 'us'],
      ['inner', 'test-command', 'us'],
    ]);
    expect(seen[0].options.timeout).to.eq(10000);
    expect(execute.callCount).to.eq(2);
    expect(execute.args[0][2]).to.not.have.property('zone');
  });

  it('does not run the action when a hook refuses it', async () => {
    hooking = true;
    const execute = spy(TestCommand.prototype, 'execute');

    expect(String(await run(['test-command', 'login', 'password', '-t', '10000', '--zone', 'closed']))).to.contain('zone closed');
    expect(execute.called).to.eq(false);
  });

  it('wraps a child command and a command listed by the manifest', async () => {
    hooking = true;

    expect(await run(['parent-cmd', 'child-cmd', '--zone', 'eu'])).to.eq('ran');
    DI.clearCache();

    const manifest = testManifest({
      root: process.cwd(),
      commands: [{ name: 'manifest-alpha', className: 'AlphaCommand', options: [], arguments: [], source: sourceRef('test/manifest-commands/AlphaCommand.ts') }],
    });
    const app = await createTestApp({
      config: { ...logging, system: { dirs: { cli: [] } } },
      register: (c) => {
        withManifest(manifest, 'require')(c);
        c.register(() => ['node', 'script.js', 'manifest-alpha', '--zone', 'eu']).as('__cli_argv_provider__', { replace: true });
      },
    });
    expect(await outcome(app.resolve(Cli))).to.eq('ran');

    expect(seen.filter((s) => s.hook === 'outer').map((s) => [s.command, s.options.zone])).to.deep.eq([
      ['child-cmd', 'eu'],
      ['manifest-alpha', 'eu'],
    ]);
  });

  it('runs no hook and no action for a command that fails before its action', async () => {
    hooking = true;
    const execute = spy(TestFailingResolveCommand.prototype, 'execute');

    expect(String(await run(['failing-resolve-cmd', '--zone', 'eu']))).to.contain('simulated unavailable dependency');
    expect(seen).to.deep.eq([]);
    expect(execute.called).to.eq(false);
  });
});
