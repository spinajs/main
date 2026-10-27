import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';
import { Injectable, PerInstanceCheck, Singleton } from '@spinajs/di';
import { fsNative } from '../src/local-provider.js';
import type { IFsLocalOptions } from '../src/index.js';
// Side-effect import: brings in the Log implementation the fs services resolve.
import '@spinajs/templates-pug';
import { createTestApp } from '@spinajs/testing';
import type { TestApp, TestAppOptions } from '@spinajs/testing';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

@Singleton()
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
        providers: [
          {
            service: 'FooFs',
            name: 'foo1',
          },
          {
            service: 'FooFs',
            name: 'foo2',
          },
          {
            service: 'fsNative',
            name: 'test',
            basePath: dir('./files'),
          },
          {
            service: 'fsNative',
            name: 'test-2',
            basePath: dir('./files-2'),
          },
          // fsTemp deliberately listed BEFORE its backend - exercises
          // dependency-aware provider creation in fsService
          {
            service: 'fsTemp',
            name: 'fs-temp',
            provider: 'fs-temp-local',
            cleanup: true,
            cleanupInterval: 15 * 1000,
            maxFileAge: 5,
          },
          {
            service: 'fsNative',
            name: 'fs-temp-local',
            basePath: dir('./temp'),
          },
          {
            service: 'fsTemp',
            name: 'fs-temp-nc',
            provider: 'fs-temp-nc-local',
            cleanup: false,
            cleanupInterval: 15 * 1000,
            maxFileAge: 5,
          },
          {
            service: 'fsNative',
            name: 'fs-temp-nc-local',
            basePath: dir('./temp-nc'),
          },
        ],
      },
    };
  }
}

export function fsApp(options: Omit<TestAppOptions, 'configuration' | 'config'> = {}): Promise<TestApp> {
  return createTestApp({ configuration: TestConfiguration, ...options });
}

// Provider that tests list in the shared configuration as service 'FooFs'.
@Injectable('fs')
@PerInstanceCheck()
export class FooFs extends fsNative<IFsLocalOptions> {
  public static INSTANCE_COUNT = 0;
  public static INSTANCE_COUNT_2 = 0;
  public async resolve() {
    if (this.Options.name === 'foo1') FooFs.INSTANCE_COUNT++;

    if (this.Options.name === 'foo2') {
      FooFs.INSTANCE_COUNT_2++;
    }
  }
}
