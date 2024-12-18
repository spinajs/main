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
import '../src/index.js';
import { FsBootsrapper, fsService } from '@spinajs/fs';

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
      fs: {
        defaultProvider: 'fs-temp',
        providers: [
          {
            service: 'fsNative',
            name: 'fs-temp',
            basePath: dir('./temp'),
          },
        ],
      },
      test: 'fs-path://fs-temp/somepath',

      nested: {
        array: [
          {
            path: 'fs-path://fs-temp/somepath3',
          },
        ],
        fs: {
          path: 'fs-path://fs-temp/somepath2',
        },
      },
    };
  }
}

async function cfg() {
  return await DI.resolve(Configuration);
}

describe('fs protocol test', function () {
  this.timeout(10000);

  before(() => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(ConnectionConf).as(Configuration);
  });

  beforeEach(async () => {
    await (await cfg()).load();
    await DI.resolve(fsService);
  });

  afterEach(async () => {
    DI.uncache(Configuration);
  });

  after(async () => {
    await DI.dispose();
  });

  it('Should load aws value to configuration', async () => {
    const c = await cfg();
    expect(c.get<string>('test').endsWith('packages\\configuration-fs-protocol\\test\\temp')).to.be.true;
    expect(c.get<string>('nested.fs.path').endsWith('packages\\configuration-fs-protocol\\test\\temp')).to.be.true;
    expect((c.get<[0]>('nested.array.path')[0] as any).path.endsWith('packages\\configuration-fs-protocol\\test\\temp')).to.be.true;

  });
});
