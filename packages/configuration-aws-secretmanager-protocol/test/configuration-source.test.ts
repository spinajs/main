/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import _ from 'lodash';
import { join, normalize, resolve } from 'path';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import './../src/index.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class ConnectionConf extends FrameworkConfiguration {
  public onLoad(): unknown {
    return {
      logger: {
        targets: [
          {
            name: 'Empty',
            type: 'BlackHoleTarget',
            layout: '${datetime} ${level} ${message} ${error} duration: ${duration} ms (${logger})',
          },
        ],

        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
      aws: {
        test: 'aws-parameters://prod/testsecret',
        secretsManager: {
          region: 'eu-central-1',
        },
      },
    };
  }
}

async function cfg() {
  return await DI.resolve(Configuration);
}

describe('Sqlite driver migration, updates, deletions & inserts', function () {
  this.timeout(10000);

  before(() => {
    DI.register(ConnectionConf).as(Configuration);
  });

  beforeEach(async () => {
    await (await cfg()).load();
  });

  afterEach(async () => {
    DI.uncache(Configuration);
  });

  after(async () => {
    await DI.dispose();
  });

  it('Should load aws value to configuration', async () => {
    const c = await cfg();
    expect(c.get('aws.test')).to.eq('testValue');
  });
});
