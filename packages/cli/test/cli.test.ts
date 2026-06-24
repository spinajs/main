import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { spy, restore } from 'sinon';
import { expect } from 'chai';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';

import { Cli } from './../src/index.js';
import { META_ARGUMENT } from './../src/decorators.js';
import { TestCommand } from './commands/TestCommand.js';
import { TestCommand2 } from './commands/TestCommand2.js';
import { TestCommand3 } from './commands/TestCommand3.js';
import { TestCommandChoices } from './commands/TestCommandChoices.js';
import { TestCommandVariadic } from './commands/TestCommandVariadic.js';
import { TestCommandAlias } from './commands/TestCommandAlias.js';
import { TestChildCommand } from './commands/TestChildCommand.js';
import { TestHookCommand } from './commands/TestHookCommand.js';
import { TestCommandEnv } from './commands/TestCommandEnv.js';
import { TestCommandConfigKey } from './commands/TestCommandConfigKey.js';
import { TestCommandAdvOpts } from './commands/TestCommandAdvOpts.js';


//const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(),'test', path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  protected onLoad() {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} (${logger})',
          },
        ],

          rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      system: {
        dirs: {
          cli: [dir('./commands')],
        },
      },
      test: {
        cli: {
          port: 8080,
        },
      },
    }
  }
}

async function c() {
  return await DI.resolve(Cli);
}

describe('Commands', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.setESMModuleSupport();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    // restore any spies so the same prototype method can be re-spied
    restore();
  });

  it('Should run command with arg and options', async () => {
    const execute = spy(TestCommand.prototype, 'execute');

    // fake params, __cli_arg_provider__ is helper
    // factory func for overriding node process.argv
    DI.register(() => ['node','script.js', 'test-command', 'userLogin', 'userPassword', '-t', '10000']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0].length).to.eq(4);
    expect(execute.args[0][0]).to.eq('userLogin');
    expect(execute.args[0][1]).to.eq('userPassword');
    expect(execute.args[0][2]).to.have.property('timeout', 10000);
  });

  it('Should run second command with arg and options', async () => {
    const execute = spy(TestCommand2.prototype, 'execute');

    // fake params, __cli_arg_provider__ is helper
    // factory func for overriding node process.argv
    DI.register(() => ['node','script.js', 'test-command2', 'userLogin2', 'userPassword2', '-t', '10000']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0].length).to.eq(4);
    expect(execute.args[0][0]).to.eq('userLogin2');
    expect(execute.args[0][1]).to.eq('userPassword2');
    expect(execute.args[0][2]).to.have.property('timeout', 10000);
  });

  it('Should use default for optional argument when omitted', async () => {
    const execute = spy(TestCommand3.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'test-command3']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0][0]).to.eq(5); // default applied
  });

  it('Should parse provided optional argument', async () => {
    const execute = spy(TestCommand3.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'test-command3', '10']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0][0]).to.eq(10); // parser applied
  });

  it('Should reject when a required option is missing', async () => {
    DI.register(() => ['node', 'script.js', 'test-command', 'login', 'pass']).as('__cli_argv_provider__');

    await expect(c()).to.be.rejected; // -t is required
  });

  it('Should reject on unknown command', async () => {
    DI.register(() => ['node', 'script.js', 'does-not-exist']).as('__cli_argv_provider__');

    await expect(c()).to.be.rejected;
  });

  it('Should preserve argument declaration order', () => {
    // stacked decorators apply bottom-up; metadata must still reflect the
    // top-to-bottom order the arguments were written in.
    const meta = Reflect.getMetadata(META_ARGUMENT, TestCommand) as Array<{ name: string }>;
    expect(meta.map((m) => m.name)).to.deep.eq(['login', 'password']);
  });

  it('Should accept an argument value within choices', async () => {
    const execute = spy(TestCommandChoices.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'choice-cmd', 'red']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0][0]).to.eq('red');
  });

  it('Should reject an argument value outside choices', async () => {
    DI.register(() => ['node', 'script.js', 'choice-cmd', 'purple']).as('__cli_argv_provider__');

    await expect(c()).to.be.rejected;
  });

  it('Should reject an option value outside choices', async () => {
    DI.register(() => ['node', 'script.js', 'choice-cmd', 'red', '-s', 'xl']).as('__cli_argv_provider__');

    await expect(c()).to.be.rejected;
  });

  it('Should collect variadic argument values into an array', async () => {
    const execute = spy(TestCommandVariadic.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'variadic-cmd', 'a', 'b', 'c']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0][0]).to.deep.eq(['a', 'b', 'c']);
  });

  it('Should run a command invoked by its alias', async () => {
    const execute = spy(TestCommandAlias.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'ac']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
  });

  it('Should route a nested subcommand under its parent', async () => {
    const execute = spy(TestChildCommand.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'parent-cmd', 'child-cmd']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
  });

  it('Should fire preAction and postAction hooks around execute', async () => {
    const pre = spy(TestHookCommand.prototype, 'onPreAction');
    const post = spy(TestHookCommand.prototype, 'onPostAction');
    const execute = spy(TestHookCommand.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'hook-cmd']).as('__cli_argv_provider__');

    await c();

    expect(pre.calledOnce).to.be.true;
    expect(execute.calledOnce).to.be.true;
    expect(post.calledOnce).to.be.true;
    expect(pre.calledBefore(execute)).to.be.true;
    expect(post.calledAfter(execute)).to.be.true;
  });

  it('Should read an option value from its environment variable', async () => {
    const execute = spy(TestCommandEnv.prototype, 'execute');
    process.env.TEST_CLI_HOST = 'env-host';

    try {
      DI.register(() => ['node', 'script.js', 'env-cmd']).as('__cli_argv_provider__');

      await c();

      expect(execute.calledOnce).to.be.true;
      expect(execute.args[0][0]).to.have.property('host', 'env-host');
    } finally {
      delete process.env.TEST_CLI_HOST;
    }
  });

  it('Should fall back to a configuration value for an option default', async () => {
    const execute = spy(TestCommandConfigKey.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'config-cmd']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0][0]).to.have.property('port', 8080); // from test.cli.port
  });

  it('Should translate help text through the global __ when present', async () => {
    const translator = spy((s: string) => s);
    (globalThis as unknown as { __?: (s: string) => string }).__ = translator;

    try {
      DI.register(() => ['node', 'script.js', 'config-cmd']).as('__cli_argv_provider__');

      await c();

      // command descriptions are run through the translator while building
      expect(translator.calledWith('config command')).to.be.true;
    } finally {
      delete (globalThis as unknown as { __?: (s: string) => string }).__;
    }
  });

  it('Should reject when conflicting options are used together', async () => {
    DI.register(() => ['node', 'script.js', 'adv-cmd', '--aaa', '--bbb']).as('__cli_argv_provider__');

    await expect(c()).to.be.rejected;
  });

  it('Should use the preset value for an optional-value option given without a value', async () => {
    const execute = spy(TestCommandAdvOpts.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'adv-cmd', '--cheese']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0][0]).to.have.property('cheese', 'cheddar');
  });

  it('Should honor a negatable option', async () => {
    const execute = spy(TestCommandAdvOpts.prototype, 'execute');

    DI.register(() => ['node', 'script.js', 'adv-cmd', '--no-sauce']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0][0]).to.have.property('sauce', false);
  });

  it('Should resolve cleanly for --version (exitCode 0 path)', async () => {
    DI.register(() => ['node', 'script.js', '--version']).as('__cli_argv_provider__');

    await expect(c()).to.be.fulfilled;
  });
});
