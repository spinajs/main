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
// registers the Log implementation - fs providers log during resolve()
import '@spinajs/log';
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

describe('fs protocol - var accessed before fs providers are registered', function () {
  this.timeout(10000);

  before(() => {
    const bootstrapper = DI.resolve(FsBootsrapper);
    bootstrapper.bootstrap();

    DI.register(ConnectionConf).as(Configuration);
  });

  after(() => {
    DI.uncache(Configuration);
  });

  it('returns null before fsService, real value after ( lazy retry )', async () => {
    const c = await cfg();

    // fs providers are not registered yet - early access must yield null, not throw
    expect(c.get('test')).to.be.null;

    // once fsService registers providers, the same var resolves on next access
    await DI.resolve(fsService);
    expect(c.get<string>('test')).to.eq(join(dir('./temp'), 'somepath'));
  });
});

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

  it('Should resolve fs-path vars at root, nested and in arrays', async () => {
    const c = await cfg();

    // fs-path://fs-temp/<path> resolves to <fs-temp basePath>/<path>
    expect(c.get<string>('test')).to.eq(join(dir('./temp'), 'somepath'));
    expect(c.get<string>('nested.fs.path')).to.eq(join(dir('./temp'), 'somepath2'));
    expect((c.get<any[]>('nested.array')[0] as any).path).to.eq(join(dir('./temp'), 'somepath3'));
  });
});
