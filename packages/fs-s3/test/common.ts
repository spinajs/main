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

      fs: {
        defaultProvider: 'test',
        s3: {
          config: {
            credentials: {
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
              accessKeyId: process.env.AWS_ACCESS_KEY_ID
            },
            region: process.env.AWS_REGION
          }
        },
        providers: [
          {
            service: 'fsNative',
            name: 'test',
            basePath: dir('./files'),
          },
          {
            service: "fsS3",
            name: "aws",
            bucket: "spinajs-test"
          },
          {
            service: 'fsNativeTemp',
            name: 'fs-temp',
            basePath: dir('./temp'),
            cleanup: true,
            cleanupInterval: 30,
            maxFileAge: 5
          },
        ],
      },


    };
  }
}

