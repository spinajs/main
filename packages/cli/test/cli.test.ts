import { TestCommand } from './commands/TestCommand';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Cli } from './../src';
import { spy } from 'sinon';
import { expect } from 'chai';
import '@spinajs/log';

//const expect = chai.expect;
chai.use(chaiAsPromised);

export function mergeArrays(target: any, source: any) {
  if (_.isArray(target)) {
    return target.concat(source);
  }
}

export function dir(path: string) {
  return resolve(normalize(join(__dirname, path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    _.mergeWith(
      this.Config,
      {
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
      },
      mergeArrays,
    );
  }
}

async function c() {
  return await DI.resolve(Cli);
}

describe('Commands', () => {
  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  it('Should run command with arg and options', async () => {
    const execute = spy(TestCommand.prototype, 'execute');

    // fake params, __cli_arg_provider__ is helper
    // factory func for overriding node process.argv
    DI.register(() => ['node', 'test-command', 'userLogin', 'userPassword', '-t', '10000']).as('__cli_argv_provider__');

    await c();

    expect(execute.calledOnce).to.be.true;
    expect(execute.args[0].length).to.eq(4);
    expect(execute.args[0][0]).to.eq('userLogin');
    expect(execute.args[0][1]).to.eq('userPassword');
    expect(execute.args[0][2]).to.have.property('timeout', 10000);
  });
});
