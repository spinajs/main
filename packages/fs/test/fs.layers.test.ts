import 'mocha';
import * as chai from 'chai';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DI, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { SilentLog } from './common.js';

import { FsProviderLayer, fsService, getFs, layeredFs, provider, publishedFs } from '../src/index.js';
import type { fs } from '../src/index.js';

const expect = chai.expect;

const root = join(tmpdir(), `spinajs-fs-layers-${process.pid}`);

/** Hands out layer-b where layer-a is asked for. */
class Redirect extends FsProviderLayer {
  public static calls = 0;

  public wrap(found: fs): fs {
    Redirect.calls += 1;
    return found.Name === 'layer-a' ? (publishedFs('layer-b') ?? found) : found;
  }
}

@NewInstance()
class FreshRedirect extends Redirect {}

describe('fs provider layers', function () {
  this.timeout(15000);
  let app: TestApp;

  before(async () => {
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    app = await createTestApp({
      config: {
        fs: {
          defaultProvider: 'layer-a',
          providers: [
            { service: 'fsNative', name: 'layer-a', basePath: join(root, 'a') },
            { service: 'fsNative', name: 'layer-b', basePath: join(root, 'b') },
          ],
        },
      },
      register: (container) => container.register(SilentLog).as(Log),
      resolve: [fsService],
    });
  });

  after(async () => {
    DI.unregister(Redirect);
    DI.uncache(Array.ofType(FsProviderLayer));
    await app?.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('without a layer, a lookup by name answers the provider fsService published', () => {
    expect(getFs('layer-a')).to.equal(publishedFs('layer-a'));
    expect(provider()).to.equal(publishedFs('layer-a'));
  });

  it('a registered layer decides what every lookup by name answers; publishedFs keeps the raw provider', () => {
    DI.register(Redirect).as(FsProviderLayer);
    DI.uncache(Array.ofType(FsProviderLayer));
    Redirect.calls = 0;

    expect(getFs('layer-a')).to.equal(publishedFs('layer-b'));
    expect(provider('layer-a')).to.equal(publishedFs('layer-b'));
    expect(getFs('layer-b')).to.equal(publishedFs('layer-b'));
    expect(publishedFs('layer-a')?.Name).to.equal('layer-a');
    expect(Redirect.calls).to.equal(3);
  });

  it('a layer that Array.ofType leaves out (a factory, a @NewInstance() class) throws instead of being skipped', () => {
    const published = publishedFs('layer-a')!;
    const registrations = [
      (c: IContainer) => c.register(() => new Redirect()).as(FsProviderLayer),
      (c: IContainer) => c.register(FreshRedirect).as(FsProviderLayer),
      (c: IContainer) => {
        c.register(Redirect).as(FsProviderLayer);
        c.register(FreshRedirect).as(FsProviderLayer);
      },
    ];
    for (const register of registrations) {
      const container = DI.child();
      register(container);
      expect(() => layeredFs(published, container)).to.throw(InvalidOperation, /cannot run/);
    }
  });
});
