import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { useTestApp, createTestApp } from '../src/index.js';

type Hook = (this: { timeout: () => number }) => Promise<void>;

// useTestApp registers its hooks on the globals; capture them so a test can run one with a chosen mocha timeout.
function captureHooks(options: Parameters<typeof useTestApp>[0]): { before: Hook; after: Hook } {
  const g = globalThis as unknown as Record<string, unknown>;
  const real = { beforeEach: g.beforeEach, afterEach: g.afterEach };
  const hooks: Record<string, Hook> = {};
  g.beforeEach = (fn: Hook) => (hooks.before = fn);
  g.afterEach = (fn: Hook) => (hooks.after = fn);
  try {
    useTestApp(options);
  } finally {
    g.beforeEach = real.beforeEach;
    g.afterEach = real.afterEach;
  }
  return { before: hooks.before, after: hooks.after };
}

describe('useTestApp', () => {
  const app = useTestApp(() => ({ config: { app: { name: 'hooked' } } }));

  it('is created before each test', () => {
    expect(app().config.get('app.name')).to.equal('hooked');
    expect(DI.get(Configuration)).to.equal(app().config);
  });

  it('is a fresh instance per test', () => {
    app().config.set('app.name', 'changed');
    expect(app().config.get('app.name')).to.equal('changed');
  });

  it('did not keep the change of the previous test', () => {
    expect(app().config.get('app.name')).to.equal('hooked');
  });
});

describe('after useTestApp', () => {
  it('root has no Configuration left', () => {
    expect(DI.RootContainer.isResolved(Configuration)).to.be.false;
  });
});

describe('useTestApp getter outside a test', () => {
  // Read at collection time, before any hook of this suite has created an app.
  const getter = useTestApp();
  let thrown: unknown;
  try {
    getter();
  } catch (err) {
    thrown = err;
  }

  it('throws when no app is live', () => {
    expect((thrown as Error | undefined)?.message).to.match(/no app is live/);
  });
});

describe('useTestApp boot timeout', () => {
  const slowBoot = { config: {}, register: () => new Promise<void>((resolve) => setTimeout(resolve, 400)) };

  it('abandons a boot that would outlive the hook, frees the slot and lets the next root app boot', async () => {
    const hooks = captureHooks(slowBoot);
    let error: Error | undefined;
    await hooks.before.call({ timeout: () => 200 }).catch((e: Error) => (error = e));

    expect(error?.message).to.match(/did not finish booting within 180 ms/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const next = await createTestApp({ config: { n: { k: 3 } } });
    expect(next.config.get('n.k')).to.equal(3);
    await next.dispose();
  });

  it('an explicit bootTimeout wins over the mocha timeout', async () => {
    const hooks = captureHooks({ ...slowBoot, bootTimeout: 50 });
    let error: Error | undefined;
    await hooks.before.call({ timeout: () => 10_000 }).catch((e: Error) => (error = e));
    expect(error?.message).to.match(/within 50 ms/);
  });

  it('keeps the default when mocha timeouts are disabled', async () => {
    const hooks = captureHooks({ config: {} });
    await hooks.before.call({ timeout: () => 0 });
    await hooks.after.call({ timeout: () => 0 });
    expect(DI.RootContainer.isResolved(Configuration)).to.be.false;
  });
});
