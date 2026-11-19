import { FrameworkConfiguration } from '@spinajs/configuration';
import chai from 'chai';
import { join, normalize, resolve } from 'path';
import _ from 'lodash';
import chaiHttp from 'chai-http';
import chaiAsPromised from 'chai-as-promised';

import chaiSubset from 'chai-subset';
import chaiLike from 'chai-like';
import chaiThings from 'chai-things';
import { Singleton } from '@spinajs/di';
import { setLogStdoutStream } from '@spinajs/log-common';
import sinon from 'sinon';

chai.use(chaiHttp);
chai.use(chaiAsPromised);
chai.use(chaiSubset);
chai.use(chaiLike);
chai.use(chaiThings);

export function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/** Runs a command as the spinajs bin does: log lines on stderr, the two streams captured apart. */
export async function captureStdio(run: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const capture = (into: string[]) => (chunk: string | Uint8Array) => {
    into.push(String(chunk));
    return true;
  };

  const stdout = sinon.stub(process.stdout, 'write').callsFake(capture(out));
  const stderr = sinon.stub(process.stderr, 'write').callsFake(capture(err));
  setLogStdoutStream('stderr');

  try {
    await run();
  } finally {
    stdout.restore();
    stderr.restore();
    setLogStdoutStream('stdout');
  }

  return { stdout: out.join(''), stderr: err.join('') };
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
