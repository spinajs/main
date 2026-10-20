import { expect } from 'chai';
import 'mocha';

import { AuthorizationModel } from '@spinajs/authz';
import { AsyncService, DI } from '@spinajs/di';

import { StaticModel, scopedContainer, uncacheOwned } from '../src/index.js';

class RootSingleton {}
class Marker {}

class ChildModel extends StaticModel {
  disposed = 0;

  constructor() {
    super({ name: 'child' });
  }

  async dispose() {
    this.disposed++;
  }
}

class ChildService extends AsyncService {
  disposed = 0;

  async dispose() {
    this.disposed++;
  }
}

describe('DI helpers (real @spinajs/di)', () => {
  const root = DI.RootContainer;
  let clearCalls = 0;
  let originalClear: () => void;

  beforeEach(() => {
    clearCalls = 0;
    originalClear = root.clearCache;
    root.clearCache = function (this: typeof root) {
      clearCalls++;
      return originalClear.call(this);
    };
    root.register(RootSingleton).asSelf();
    root.register(Marker).asSelf();
  });

  afterEach(() => {
    root.clearCache = originalClear;
    for (const t of [RootSingleton, Marker]) {
      root.unregister(t);
      root.uncache(t);
    }
  });

  it('uncacheOwned drops only the listed types from root', () => {
    const first = root.resolve(RootSingleton);
    const marker = root.resolve(Marker);
    uncacheOwned([RootSingleton]);
    expect(root.get(RootSingleton, false)).to.eq(undefined);
    expect(root.get(Marker, false)).to.eq(marker);
    expect(root.resolve(RootSingleton)).to.not.eq(first);
    expect(clearCalls).to.eq(0);
  });

  it('scopedContainer: child-owned models live and die in the child; root singletons are uncached, never cleared', async () => {
    const marker = root.resolve(Marker);
    const scope = await scopedContainer({
      register: [[ChildModel, AuthorizationModel], ChildService],
      resolve: async (c) => ({ models: await c.resolve(Array.chainOf(AuthorizationModel)), single: c.resolve(RootSingleton), service: await c.resolve(ChildService) }),
      uncache: [RootSingleton],
    });

    const model = scope.resolved.models.find((m) => m.name === 'child') as ChildModel;
    expect(model).to.be.instanceOf(ChildModel);
    expect(scope.container.get(ChildModel, false)).to.eq(model);
    expect(root.hasRegistered(ChildModel, false)).to.eq(false);
    expect(root.get(ChildModel, false)).to.eq(undefined);
    // F2 (DI-2): a root-registered singleton resolved through the child is created in root
    expect(root.get(RootSingleton, false)).to.eq(scope.resolved.single);

    await scope.dispose();
    await scope.dispose();

    expect(model.disposed).to.eq(1);
    expect(scope.resolved.service.disposed).to.eq(1);
    expect(root.get(RootSingleton, false)).to.eq(undefined);
    expect(root.get(Marker, false)).to.eq(marker);
    expect(clearCalls).to.eq(0);
  });

  it('scopedContainer accepts a register function and a parent container', async () => {
    const parent = root.child();
    try {
      const scope = await scopedContainer({
        parent,
        register: (c) => c.register(ChildModel).as(AuthorizationModel),
        resolve: (c) => c.resolve(Array.chainOf(AuthorizationModel)),
      });
      expect(scope.container.Parent).to.eq(parent);
      expect(((await scope.resolved) as AuthorizationModel[]).map((m) => m.name)).to.include('child');
      await scope.dispose();
    } finally {
      await parent.dispose();
    }
  });
});
