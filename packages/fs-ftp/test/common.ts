import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

export class TestConfiguration extends FrameworkConfiguration {
  public async resolve(): Promise<void> {
    await super.resolve();

    this.Config = {
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
        defaultProvider: 'test',
        s3: {
          config: {
            // needed with localstack testing
            forcePathStyle: true,
            endpoint: 'http://localhost:4566',
            credentials: {
              secretAccessKey: 'test',
              accessKeyId: 'test',
            },
            region: 'us-west-1',
          },
        },
        providers: [
          {
            service: 'fsNative',
            name: 'test',
            basePath: dir('./files'),
          },
          {
            service: 'fsNative',
            name: 'fs-temp',
            basePath: dir('./temp'),
          },
          {
            service: 'fsFTP',
            name: 'ftp',
            host: '127.0.0.1',
            user: 'user',
            password: '123',
            port : 21
          },
        ],
      },
    };
  }
}
