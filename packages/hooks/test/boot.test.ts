import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import { AsyncService, Autoinject } from '@spinajs/di';

import { ActionHook, ActionHookFailed, Hooks } from '../src/index.js';
import type { ActionPattern } from '../src/index.js';
import { TestLog, boot, track, disposeChildren, rejectionOf, useTestLog } from './support.js';

const expect = chai.expect;

declare module '@spinajs/hooks' {
  interface HookActions {
    'boot.ping': { input: { n: number }; output: number };
    'boot.other': { input: { n: number }; output: number };
  }
}

const echo = async (i: { n: number }) => i.n;

class Dependency {
  static built = 0;

  constructor() {
    Dependency.built++;
  }
}

class LazyHook extends ActionHook {
  static readonly seen: LazyHook[] = [];

  @Autoinject(Dependency)
  protected Dependency: Dependency;

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  get injected(): boolean {
    return this.Dependency instanceof Dependency;
  }

  before(): void {
    LazyHook.seen.push(this);
  }
}

/** Injects Hooks, as a service that runs actions would. */
class Auditor {
  @Autoinject(Hooks)
  readonly Hooks: Hooks;
}

class AuditingHook extends ActionHook {
  static readonly seen: Hooks[] = [];

  @Autoinject(Auditor)
  protected Auditor: Auditor;

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  before(): void {
    AuditingHook.seen.push(this.Auditor.Hooks);
  }
}

class LateHook extends ActionHook {
  static readonly seen: number[] = [];

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  before(): void {
    LateHook.seen.push(1);
  }
}

class FlakyDependency {
  static failing = true;

  constructor() {
    if (FlakyDependency.failing) throw new Error('dependency down');
  }
}

class FlakyHook extends ActionHook {
  static readonly seen: number[] = [];

  @Autoinject(FlakyDependency)
  protected Dependency: FlakyDependency;

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  before(): void {
    FlakyHook.seen.push(1);
  }
}

class FlakyAfterHook extends ActionHook {
  @Autoinject(FlakyDependency)
  protected Dependency: FlakyDependency;

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  after(): void {}
}

class Hanging extends AsyncService {
  async resolve(): Promise<void> {
    await new Promise<void>(() => undefined);
  }
}

class HangingBefore extends ActionHook {
  static readonly seen: number[] = [];

  @Autoinject(Hanging)
  protected Hanging: Hanging;

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  before(): void {
    HangingBefore.seen.push(1);
  }
}

class Gate extends AsyncService {
  static open: () => void;
  static reject: (e: Error) => void;
  static opened: Promise<void>;

  static arm(): void {
    Gate.opened = new Promise<void>((resolve, reject) => {
      Gate.open = resolve;
      Gate.reject = reject;
    });
    Gate.opened.catch(() => undefined);
  }

  async resolve(): Promise<void> {
    await Gate.opened;
  }
}

class GatedBefore extends ActionHook {
  static readonly seen: number[] = [];

  @Autoinject(Gate)
  protected Gate: Gate;

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  before(): void {
    GatedBefore.seen.push(1);
  }
}

class HangingAfter extends ActionHook {
  @Autoinject(Hanging)
  protected Hanging: Hanging;

  readonly actions: readonly ActionPattern[] = ['boot.ping'];

  after(): void {}
}

class NoActions extends ActionHook {
  readonly actions = undefined as unknown as readonly ActionPattern[];
}

class NanOrder extends ActionHook {
  readonly actions: readonly ActionPattern[] = ['boot.ping'];
  readonly order = NaN;
}

class NonStringAction extends ActionHook {
  readonly actions = [1] as unknown as readonly ActionPattern[];
}

describe('DefaultHooks boot', function () {
  this.timeout(10000);
  useTestLog();

  beforeEach(() => {
    Dependency.built = 0;
    LazyHook.seen.length = 0;
    AuditingHook.seen.length = 0;
    LateHook.seen.length = 0;
  });

  afterEach(disposeChildren);

  it('collects hook types at boot and resolves a hook instance on the first run of an action it matches', async () => {
    const { hooks } = await boot({}, (c) => c.register(LazyHook).as(ActionHook));

    expect(hooks.has('boot.ping')).to.be.true;
    expect(Dependency.built).to.eq(0);

    await hooks.run('boot.other', { n: 1 }, echo, { mutable: [] });
    expect(Dependency.built).to.eq(0);

    await hooks.run('boot.ping', { n: 2 }, echo, { mutable: [] });
    await hooks.run('boot.ping', { n: 3 }, echo, { mutable: [] });

    expect(Dependency.built).to.eq(1);
    expect(LazyHook.seen).to.have.length(2);
    expect(LazyHook.seen[0].injected).to.be.true;
    expect(LazyHook.seen[1]).to.equal(LazyHook.seen[0]);
  });

  it('boots with a hook that injects a service that injects Hooks', async () => {
    const { hooks } = await boot({}, (c) => c.register(AuditingHook).as(ActionHook));

    expect(await hooks.run('boot.ping', { n: 4 }, echo, { mutable: [] })).to.eq(4);

    expect(AuditingHook.seen).to.have.length(1);
    expect(AuditingHook.seen[0]).to.equal(hooks);
  });

  it('does not run a hook registered after boot', async () => {
    const { child, hooks } = await boot({}, (c) => c.register(LazyHook).as(ActionHook));
    child.register(LateHook).as(ActionHook);

    await hooks.run('boot.ping', { n: 5 }, echo, { mutable: [] });

    expect(LazyHook.seen).to.have.length(1);
    expect(LateHook.seen).to.deep.eq([]);
  });

  it('reports no action for a hook registered after boot', async () => {
    const { child, hooks } = await boot();
    child.register(LateHook).as(ActionHook);

    expect(hooks.has('boot.ping')).to.be.false;
    await hooks.run('boot.ping', { n: 6 }, echo, { mutable: [] });
    expect(LateHook.seen).to.deep.eq([]);
  });

  describe('a hook declaration that is not valid', () => {
    for (const [title, hook] of [
      ['no actions', NoActions],
      ['a non-string action', NonStringAction],
      ['an order that is not a finite number', NanOrder],
    ] as const) {
      it(`fails boot for a hook with ${title}`, async () => {
        const e = await rejectionOf(boot({}, (c) => c.register(hook).as(ActionHook)));

        expect((e as Error).message).to.contain(`Hook ${hook.name} declares no valid actions/order`);
      });
    }
  });

  describe('a factory that returns no hook instance', () => {
    for (const [title, value] of [
      ['null', null],
      ['a primitive', 42],
    ] as const) {
      it(`fails boot with a named error for ${title}`, async () => {
        const factory = () => value as never;
        const e = await rejectionOf(boot({}, (c) => c.register(factory).as(ActionHook)));

        expect((e as Error).message).to.contain('Hook factory factory returned no hook instance');
      });
    }

    it('names an anonymous factory', async () => {
      const e = await rejectionOf(boot({}, (c) => c.register((() => undefined) as never).as(ActionHook)));

      expect((e as Error).message).to.contain('Hook factory anonymous factory returned no hook instance');
    });
  });

  describe('a hook whose DI resolution hangs', () => {
    let clock: sinon.SinonFakeTimers | undefined;

    beforeEach(() => HangingBefore.seen.splice(0));
    afterEach(() => {
      clock?.restore();
      clock = undefined;
    });

    it('rejects a refusable run with ActionHookFailed(timeout) and logs it', async () => {
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => c.register(HangingBefore).as(ActionHook));
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const run = track(hooks.run('boot.ping', { n: 1 }, echo, { mutable: [] }));
      await clock.tickAsync(100);

      expect(run.settled).to.be.true;
      expect(run.error).to.be.instanceOf(ActionHookFailed);
      expect((run.error as ActionHookFailed).reason).to.eq('timeout');
      expect((run.error as ActionHookFailed).hook).to.eq('HangingBefore');
      expect(TestLog.of('hooks').some((l) => l.text.includes('HangingBefore'))).to.be.true;
    });

    it('with refusable: false, logs it, skips the hook and runs the action', async () => {
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => c.register(HangingBefore).as(ActionHook));
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const run = track(hooks.run('boot.ping', { n: 2 }, echo, { mutable: [], refusable: false }));
      await clock.tickAsync(100);

      expect(run.value).to.eq(2);
      expect(HangingBefore.seen).to.deep.eq([]);
      expect(TestLog.of('hooks').some((l) => l.text.includes('HangingBefore'))).to.be.true;
    });

    it('fails fast while an overdue resolution is pending, then uses the hook once it resolves', async () => {
      Gate.arm();
      GatedBefore.seen.length = 0;
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => c.register(GatedBefore).as(ActionHook));
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const first = track(hooks.run('boot.ping', { n: 1 }, echo, { mutable: [] }));
      await clock.tickAsync(99);
      expect(first.settled).to.be.false;
      await clock.tickAsync(1);
      expect((first.error as ActionHookFailed).reason).to.eq('timeout');

      const second = track(hooks.run('boot.ping', { n: 2 }, echo, { mutable: [] }));
      await clock.tickAsync(0);
      expect((second.error as ActionHookFailed).reason).to.eq('timeout');
      const skipped = track(hooks.run('boot.ping', { n: 2 }, echo, { mutable: [], refusable: false }));
      await clock.tickAsync(0);
      expect(skipped.value).to.eq(2);
      expect(GatedBefore.seen).to.deep.eq([]);

      Gate.open();
      await clock.tickAsync(0);
      const third = track(hooks.run('boot.ping', { n: 3 }, echo, { mutable: [] }));
      await clock.tickAsync(0);
      expect(third.value).to.eq(3);
      expect(GatedBefore.seen).to.deep.eq([1]);
    });

    it('logs the fast-path failure once per overdue period', async () => {
      Gate.arm();
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => c.register(GatedBefore).as(ActionHook));
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const logged = () => TestLog.of('hooks').filter((l) => l.text.includes('GatedBefore')).length;
      const fastRun = async (n: number) => {
        const run = track(hooks.run('boot.ping', { n }, echo, { mutable: [] }));
        await clock!.tickAsync(0);
        expect((run.error as ActionHookFailed).reason).to.eq('timeout');
      };

      const first = track(hooks.run('boot.ping', { n: 1 }, echo, { mutable: [] }));
      await clock.tickAsync(100);
      expect(first.settled).to.be.true;
      expect(logged()).to.eq(1);

      await fastRun(2);
      await fastRun(3);
      await fastRun(4);
      expect(logged()).to.eq(2);

      Gate.reject(new Error('late failure'));
      await clock.tickAsync(0);
      Gate.arm();
      const retry = track(hooks.run('boot.ping', { n: 5 }, echo, { mutable: [] }));
      await clock.tickAsync(100);
      expect(retry.settled).to.be.true;
      expect(logged()).to.eq(3);

      await fastRun(6);
      await fastRun(7);
      expect(logged()).to.eq(4);
    });

    it('retries resolution on the next run when the overdue resolution rejects', async () => {
      Gate.arm();
      GatedBefore.seen.length = 0;
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => c.register(GatedBefore).as(ActionHook));
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const first = track(hooks.run('boot.ping', { n: 1 }, echo, { mutable: [] }));
      await clock.tickAsync(100);
      expect(first.settled).to.be.true;

      Gate.reject(new Error('late failure'));
      await clock.tickAsync(0);
      Gate.arm();
      const next = track(hooks.run('boot.ping', { n: 2 }, echo, { mutable: [] }));
      await clock.tickAsync(99);
      expect(next.settled).to.be.false;
      await clock.tickAsync(1);
      expect((next.error as ActionHookFailed).reason).to.eq('timeout');
    });

    it('logs and skips an after-only hook whose resolution hangs', async () => {
      const { hooks } = await boot({ hooks: { timeoutMs: 100 } }, (c) => c.register(HangingAfter).as(ActionHook));
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const run = track(hooks.run('boot.ping', { n: 3 }, echo, { mutable: [] }));
      await clock.tickAsync(100);

      expect(run.value).to.eq(3);
      expect(TestLog.of('hooks').filter((l) => l.text.includes('HangingAfter'))).to.have.length(1);
    });
  });

  describe('a hook whose DI resolution fails', () => {
    beforeEach(() => {
      FlakyDependency.failing = true;
      FlakyHook.seen.length = 0;
    });

    it('rejects a refusable run with ActionHookFailed(error), logs it, and retries resolution on the next run', async () => {
      const { hooks } = await boot({}, (c) => c.register(FlakyHook).as(ActionHook));

      const e = await rejectionOf(hooks.run('boot.ping', { n: 1 }, echo, { mutable: [] }));
      expect(e).to.be.instanceOf(ActionHookFailed);
      expect((e as ActionHookFailed).reason).to.eq('error');
      expect((e as ActionHookFailed).hook).to.eq('FlakyHook');
      expect(TestLog.of('hooks').some((l) => l.text.includes('FlakyHook'))).to.be.true;
      expect(TestLog.of('hooks').some((l) => l.text.includes('dependency down'))).to.be.false;

      FlakyDependency.failing = false;
      expect(await hooks.run('boot.ping', { n: 2 }, echo, { mutable: [] })).to.eq(2);
      expect(FlakyHook.seen).to.have.length(1);
    });

    it('never fails a refusable run because an after-only hook cannot be resolved', async () => {
      const { hooks } = await boot({}, (c) => c.register(FlakyAfterHook).as(ActionHook));

      expect(await hooks.run('boot.ping', { n: 4 }, echo, { mutable: [] })).to.eq(4);

      expect(TestLog.of('hooks').filter((l) => l.text.includes('FlakyAfterHook'))).to.have.length(1);
    });

    it('with refusable: false, logs it, skips the hook and runs the action', async () => {
      const { hooks } = await boot({}, (c) => c.register(FlakyHook).as(ActionHook));

      expect(await hooks.run('boot.ping', { n: 3 }, echo, { mutable: [], refusable: false })).to.eq(3);

      expect(FlakyHook.seen).to.have.length(0);
      expect(TestLog.of('hooks').some((l) => l.text.includes('FlakyHook'))).to.be.true;
    });
  });
});
