import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { spy } from 'sinon';
import { expect } from 'chai';

import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import '@spinajs/log';

import { Cli } from './../src/index.js';
import { TestCommand } from './commands/TestCommand.js';
import { TestCommand2 } from './commands/TestCommand2.js';


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
});
