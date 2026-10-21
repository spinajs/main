import * as chai from 'chai';
import 'mocha';
import { Autoinject } from '@spinajs/di';

import { ActionHook, Hooks } from '../src/index.js';
import type { ActionPattern } from '../src/index.js';
import { boot, disposeChildren, useTestLog } from './support.js';

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
});
