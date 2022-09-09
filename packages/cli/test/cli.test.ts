import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { join, normalize, resolve } from 'path';
import * as _ from 'lodash';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { DI } from '@spinajs/di';
import { Cli } from '@spinajs/cli';

const expect = chai.expect;
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
  public async resolveAsync(): Promise<void> {
    await super.resolveAsync();

    _.mergeWith(
      this.Config,
      {
        logger: {
          targets: [
            {
              name: 'Empty',
              type: 'BlackHoleTarget',
              layout: '{datetime} {level} {message} {error} duration: {duration} ({logger})',
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
    // fake argv params
    process.argv = ['', '', 'test-command', 'userLogin', 'userPassword', '-t', '10000'];
    await c();
  });

  it('Should fail when command not exists', async () => {
    // fake argv params
    process.argv = ['', '', 'nonExisting'];
    await c();
  });
});
