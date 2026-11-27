import 'mocha';
import * as chai from 'chai';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncService, Autoinject, DI, NewInstance, Singleton } from '@spinajs/di';
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

@Singleton()
class SingletonOfFresh extends FreshRedirect {}

const applied: string[] = [];

function swapped(found: fs, from: string, to: string): fs {
  return found.Name === from ? (publishedFs(to) ?? found) : found;
}

/** With BToA, the order of the two decides the result: a lookup of layer-a ends at layer-a only when AToB runs first. */
class AToB extends FsProviderLayer {
  public wrap(found: fs): fs {
    applied.push('AToB');
    return swapped(found, 'layer-a', 'layer-b');
  }
}

class BToA extends FsProviderLayer {
  public wrap(found: fs): fs {
    applied.push('BToA');
    return swapped(found, 'layer-b', 'layer-a');
  }
}

class AToBReplaced extends AToB {
  public wrap(found: fs): fs {
    applied.push('AToBReplaced');
    return found;
  }
}

@NewInstance()
class FreshAToBReplaced extends AToB {}

class SlowBoot extends AsyncService {
  public async resolve() {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class SlowLayer extends FsProviderLayer {
  @Autoinject(SlowBoot)
  public Boot: SlowBoot;

  public wrap(found: fs): fs {
    return found;
  }
}

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

  beforeEach(() => {
    applied.length = 0;
  });

  afterEach(() => {
    DI.unregister(Redirect);
    DI.unregister(AToB);
    DI.uncache(Array.ofType(FsProviderLayer));
  });

  after(async () => {
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
      // the singleton subclass instance is an instance of the skipped @NewInstance() base too
      (c: IContainer) => {
        c.register(FreshRedirect).as(FsProviderLayer);
        c.register(SingletonOfFresh).as(FsProviderLayer);
      },
      (c: IContainer) => {
        c.register(AToB).as(FsProviderLayer);
        c.register(FreshAToBReplaced).as(AToB);
      },
      (c: IContainer) => {
        c.register(AToB).as(FsProviderLayer);
        c.register(() => new AToBReplaced()).as(AToB);
      },
    ];
    for (const register of registrations) {
      const container = DI.child();
      register(container);
      expect(() => layeredFs(published, container)).to.throw(InvalidOperation, /cannot run/);
    }
  });

  it('layers apply in registration order, each to what the one before handed out', () => {
    const published = publishedFs('layer-a')!;
    const forward = DI.child();
    forward.register(AToB).as(FsProviderLayer);
    forward.register(BToA).as(FsProviderLayer);
    const backward = DI.child();
    backward.register(BToA).as(FsProviderLayer);
    backward.register(AToB).as(FsProviderLayer);

    expect(layeredFs(published, forward)).to.equal(published);
    expect(layeredFs(published, backward)).to.equal(publishedFs('layer-b'));
    expect(applied).to.deep.equal(['AToB', 'BToA', 'BToA', 'AToB']);
  });

  it('a layer class replaced the DI way (register(Sub).as(Layer)) is applied in its place, once per lookup', () => {
    const published = publishedFs('layer-a')!;
    const container = DI.child();
    container.register(AToB).as(FsProviderLayer);
    container.register(AToBReplaced).as(AToB);

    expect(layeredFs(published, container)).to.equal(published);
    expect(layeredFs(published, container)).to.equal(published);
    expect(applied).to.deep.equal(['AToBReplaced', 'AToBReplaced']);
  });

  it('a layer that resolves asynchronously throws InvalidOperation until it is resolved, not a TypeError', async () => {
    const published = publishedFs('layer-a')!;
    const container = DI.child();
    container.register(SlowLayer).as(FsProviderLayer);

    expect(() => layeredFs(published, container)).to.throw(InvalidOperation, /must be synchronous/);
    await Promise.resolve(container.resolve(Array.ofType(FsProviderLayer)));
    expect(layeredFs(published, container)).to.equal(published);
  });

  it('a child container applies the root container layers first, then its own, each class once', () => {
    DI.register(AToB).as(FsProviderLayer);
    const published = publishedFs('layer-a')!;
    const child = DI.child();
    child.register(BToA).as(FsProviderLayer);
    child.register(AToB).as(FsProviderLayer);

    expect(layeredFs(published, child)).to.equal(published);
    expect(applied).to.deep.equal(['AToB', 'BToA']);
  });
});
