import * as chai from 'chai';
import 'mocha';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { RecordingAudit, StaticModel, userPrincipal } from '@spinajs/authz-testing';
import type { ModelCall, StaticModelOptions } from '@spinajs/authz-testing';

import { DefaultAuthzService } from '../../src/host/service.js';
import { AuthzContributor } from '../../src/host/contributor.js';
import { authz } from '../../src/host/authz.js';
import { requestScope } from '../../src/host/storage.js';
import { AuthorizationModel, AuthzAdmin, AuthzConfigError, ChangeBus, DecisionAudit, DecisionCache, LruDecisionCache, ResourceAdapter, SYSTEM, TRUE, UNATTENDED, UnknownPermission } from '../../src/index.js';
import type { AuthzChange, AuthzService, ModelInitContext, ResourceRef } from '../../src/index.js';
import type { LruDecisionCacheOptions } from '../../src/index.js';
import { domains, installHost, instance, registerInRoot, resetHost, resetRoot, rootService, setConfig, uninstallHost } from './support.js';
import type { DefaultAuthzDomains } from '../../src/host/domains.js';

const expect = chai.expect;

const alice = userPrincipal('alice');
const doc1: ResourceRef = { type: 'doc', id: '1' };

const allowing = (name: string, opts: StaticModelOptions = {}) => new StaticModel({ name, votes: { '*': { permitWhen: TRUE } }, ...opts });
const silent = (name: string) => new StaticModel({ name });
const count = (m: StaticModel, method: ModelCall['method']) => m.calls.filter((c) => c.method === method).length;

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('expected a rejection');
}

class MissingCache extends DecisionCache {
  get(): undefined {
    return undefined;
  }
  set(): void {}
  invalidate(): void {}
}

/** Records the tags of every invalidate() the service receives. */
function spyInvalidate(svc: AuthzService): (readonly string[])[] {
  const calls: (readonly string[])[] = [];
  const original = svc.invalidate.bind(svc);
  svc.invalidate = (tags: readonly string[]) => {
    calls.push(tags);
    original(tags);
  };
  return calls;
}

const change = (domain?: string, tags: string[] = ['subject:user:alice']): AuthzChange => ({ ...(domain === undefined ? {} : { domain }), tags, at: new Date(0) });

class CountingBus extends ChangeBus {
  readonly subscribers = new Set<(c: AuthzChange) => void>();

  async publish(c: AuthzChange): Promise<void> {
    for (const fn of [...this.subscribers]) fn(c);
  }

  subscribe(fn: (c: AuthzChange) => void): () => void {
    const own = (c: AuthzChange) => fn(c);
    this.subscribers.add(own);
    return () => {
      this.subscribers.delete(own);
    };
  }
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** Its init signals `started`, then waits for `release` (or runs `during`). */
class GatedModel extends StaticModel {
  constructor(opts: StaticModelOptions, private readonly hooks: { started?: () => void; release?: Promise<void>; during?: () => Promise<void> }) {
    super(opts);
  }

  async init(ctx: ModelInitContext): Promise<void> {
    super.init(ctx);
    this.hooks.started?.();
    await this.hooks.during?.();
    await this.hooks.release;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Replaces one method of the domains singleton for the duration of `fn`. */
async function patched<K extends 'attach' | 'enter'>(d: DefaultAuthzDomains, key: K, wrap: (original: DefaultAuthzDomains[K]) => DefaultAuthzDomains[K], fn: () => Promise<void>): Promise<void> {
  const original = d[key].bind(d) as DefaultAuthzDomains[K];
  (d as unknown as Record<string, unknown>)[key] = wrap(original);
  try {
    await fn();
  } finally {
    delete (d as unknown as Record<string, unknown>)[key];
  }
}

describe('DefaultAuthzService', function () {
  this.timeout(10000);

  before(async () => {
    await installHost();
  });

  after(async () => {
    await uninstallHost();
  });

  beforeEach(async () => {
    await resetHost();
    setConfig('authz.permissions', { 'doc:read': {}, 'doc:write': {} });
  });

  describe('root', () => {
    it('boots with nothing registered and denies with no_access', async () => {
      const svc = await rootService();
      expect(svc).to.be.instanceOf(DefaultAuthzService);
      expect(svc.domain).to.equal('root');
      expect(svc.models()).to.deep.equal([]);
      const d = await svc.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('no_access');
    });

    it('throws AuthzConfigError from every method before resolve() finished', async () => {
      const svc = new DefaultAuthzService(DI.RootContainer);
      expect(() => svc.domain).to.throw(AuthzConfigError, /not resolved/);
      expect(() => svc.models()).to.throw(AuthzConfigError, /not resolved/);
      expect(() => svc.current()).to.throw(AuthzConfigError, /not resolved/);
      expect(() => svc.invalidate(['*'])).to.throw(AuthzConfigError, /not resolved/);
      expect(() => svc.filterNow(alice, 'doc:read', 'doc')).to.throw(AuthzConfigError, /not resolved/);
      expect(() => svc.admin()).to.throw(AuthzConfigError, /not resolved/);
      expect(await rejection(svc.check({ principal: alice, permission: 'doc:read' }))).to.be.instanceOf(AuthzConfigError);
      expect(await rejection(svc.can(alice, 'doc:read'))).to.be.instanceOf(AuthzConfigError);
      expect(await rejection(svc.runAs(alice, 'job', async () => 1))).to.be.instanceOf(AuthzConfigError);
      expect(await rejection(svc.preload(alice))).to.be.instanceOf(AuthzConfigError);
    });

    it('fails boot on legacy rbac keys when authz.config.rejectLegacyKeys is true', async () => {
      setConfig('rbac', { grants: { admin: ['*'] } });
      setConfig('authz.config', { rejectLegacyKeys: true });
      const err = await rejection(rootService());
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message)
        .to.match(/rbac\.grants/)
        .and.match(/"root"/);
      expect(() => authz()).to.throw(AuthzConfigError);
    });

    it('boots with legacy rbac keys when rejectLegacyKeys is false', async () => {
      setConfig('rbac', { grants: { admin: ['*'] } });
      const svc = await rootService();
      expect(svc.domain).to.equal('root');
    });
  });

  describe('models across domains', () => {
    it('a child adds a model; root keeps only its own', async () => {
      const rootModel = silent('r');
      registerInRoot(AuthorizationModel, instance(rootModel));
      const d = await domains();
      const fsModel = allowing('fsm');
      d.create('fs').register(instance(fsModel)).as(AuthorizationModel);

      const fs = await d.service('fs');
      const root = await rootService();
      expect(fs.models()).to.have.length(2);
      expect(fs.models()[0]).to.equal(rootModel);
      expect(fs.models()[1]).to.equal(fsModel);
      expect(root.models()).to.have.length(1);
      expect(root.models()[0]).to.equal(rootModel);
      expect(Object.isFrozen(fs.models())).to.equal(true);

      expect((await fs.check({ principal: alice, permission: 'doc:read', resource: doc1 })).allowed).to.equal(true);
      expect((await root.check({ principal: alice, permission: 'doc:read', resource: doc1 })).allowed).to.equal(false);
    });

    it('a child model overrides an ancestor model of the same name', async () => {
      const rootM = silent('m');
      registerInRoot(AuthorizationModel, instance(rootM));
      const d = await domains();
      const childM = allowing('m');
      d.create('ov').register(instance(childM)).as(AuthorizationModel);

      const ov = await d.service('ov');
      expect(ov.models()).to.have.length(1);
      expect(ov.models()[0]).to.equal(childM);
      expect(await ov.can(alice, 'doc:read', doc1)).to.equal(true);
      expect(await (await rootService()).can(alice, 'doc:read', doc1)).to.equal(false);
    });

    it('two models of one name in the same level fail boot (rule 2) naming the domain', async () => {
      const d = await domains();
      const c = d.create('dup');
      c.register(instance(silent('x'))).as(AuthorizationModel);
      c.register(instance(allowing('x'))).as(AuthorizationModel);
      const err = await rejection(d.service('dup'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message)
        .to.contain('"dup"')
        .and.match(/2 models are registered with this name/);
    });

    it('disable drops an ancestor model, cumulatively; the own model of a disabled name stays', async () => {
      const a = silent('a');
      const b = silent('b');
      registerInRoot(AuthorizationModel, instance(a));
      registerInRoot(AuthorizationModel, instance(b));
      setConfig(['authz', 'domains', 'c1'], { disable: ['a'] });
      setConfig(['authz', 'domains', 'c2'], { parent: 'c1', disable: ['b'] });
      const d = await domains();
      const ownA = allowing('a');
      d.create('c1').register(instance(ownA)).as(AuthorizationModel);
      d.create('c2');

      const c1 = await d.service('c1');
      const c2 = await d.service('c2');
      expect(c1.models()).to.deep.equal([b, ownA]);
      expect(c2.models()).to.deep.equal([ownA]);
      expect((await rootService()).models()).to.deep.equal([a, b]);
    });

    it('warns when disable names a model no ancestor registers', async () => {
      const a = silent('a');
      registerInRoot(AuthorizationModel, instance(a));
      setConfig(['authz', 'domains', 'c1'], { disable: ['aa'] });
      const d = await domains();
      d.create('c1');
      const warned: string[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(' '));
      try {
        expect((await d.service('c1')).models()).to.deep.equal([a]);
      } finally {
        console.warn = original;
      }
      expect(warned.some((w) => w.includes('"aa"') && w.includes('no ancestor domain registers'))).to.equal(true);
    });

    it('inits a model listed by root and child once; its init permissions are checkable in the child', async () => {
      class Registering extends StaticModel {
        init(ctx: ModelInitContext): void {
          super.init(ctx);
          ctx.registerPermissions([{ name: 'note:read', resource: 'note', action: 'read', types: ['note'] }]);
        }
      }
      const m = new Registering({ name: 'reg', votes: { '*': { permitWhen: TRUE } } });
      registerInRoot(AuthorizationModel, instance(m));
      const d = await domains();
      d.create('kid').register(instance(m)).as(AuthorizationModel);

      const kid = await d.service('kid');
      expect(kid.models()).to.deep.equal([m]);
      expect(count(m, 'init')).to.equal(1);
      expect((m.calls[0].args[0] as ModelInitContext).domain).to.equal('root');
      expect(await kid.can(alice, 'note:read', { type: 'note', id: 'n1' })).to.equal(true);
    });

    it('a model init reads authz.<model>.* through config()', async () => {
      let seen: unknown;
      class Reading extends StaticModel {
        init(ctx: ModelInitContext): void {
          seen = [ctx.config('opts.level', 0), ctx.config('missing', 'dflt')];
        }
      }
      setConfig(['authz', 'rd', 'opts'], { level: 3 });
      const d = await domains();
      d.create('rd-domain')
        .register(instance(new Reading({ name: 'rd' })))
        .as(AuthorizationModel);
      await d.service('rd-domain');
      expect(seen).to.deep.equal([3, 'dflt']);
    });
  });

  describe('boot failures', () => {
    it('combine naming an unregistered model', async () => {
      setConfig(['authz', 'domains', 'bad'], { combine: { default: { algorithm: 'deny-overrides', models: ['nope'] } } });
      const d = await domains();
      d.create('bad');
      const err = await rejection(d.service('bad'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('"bad"').and.contain('nope');
    });

    it('a contributor permission ref to an unregistered permission', async () => {
      class Refs extends AuthzContributor {
        contribute() {
          return { permissionRefs: [{ permission: 'ghost:read', source: 'test' }] };
        }
      }
      const d = await domains();
      d.create('refs').register(instance(new Refs())).as(AuthzContributor);
      const err = await rejection(d.service('refs'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('"refs"').and.contain('ghost:read');
    });

    it('a model whose init throws, cause kept; a retry boots again instead of reusing a half-built service', async () => {
      const boom = new Error('boom');
      let fail = true;
      class Throwing extends StaticModel {
        init(ctx: ModelInitContext): void {
          super.init(ctx);
          if (fail) throw boom;
        }
      }
      const m = new Throwing({ name: 'thr', votes: { '*': { permitWhen: TRUE } } });
      const d = await domains();
      d.create('thr-domain').register(instance(m)).as(AuthorizationModel);
      const err = await rejection(d.service('thr-domain'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('"thr-domain"').and.contain('"thr"');
      expect(err.cause).to.equal(boom);
      expect(() => authz('thr-domain')).to.throw(AuthzConfigError);

      fail = false;
      const svc = await d.service('thr-domain');
      expect(count(m, 'init')).to.equal(2);
      expect(await svc.can(alice, 'doc:read', doc1)).to.equal(true);
      expect(authz('thr-domain')).to.equal(svc);
    });

    it('a container that is not a domain', async () => {
      const c = DI.RootContainer.child();
      try {
        const err = await rejection(c.resolve(DefaultAuthzService) as Promise<unknown>);
        expect(err).to.be.instanceOf(AuthzConfigError);
        expect(err.message).to.match(/not an authz domain/);
      } finally {
        await c.dispose();
      }
    });
  });

  describe('decision cache', () => {
    it('one cache per domain, built with the domain options', async () => {
      const made: { cache: LruDecisionCache; opts?: LruDecisionCacheOptions }[] = [];
      registerInRoot(DecisionCache, (_c, opts?: LruDecisionCacheOptions) => {
        const cache = new LruDecisionCache(opts ?? {});
        made.push({ cache, opts });
        return cache;
      });
      setConfig(['authz', 'domains', 'ca', 'cache'], { maxEntries: 7 });
      const d = await domains();
      const ma = allowing('ma');
      const mb = allowing('mb');
      d.create('ca').register(instance(ma)).as(AuthorizationModel);
      d.create('cb').register(instance(mb)).as(AuthorizationModel);
      const ca = await d.service('ca');
      const cb = await d.service('cb');

      expect(made).to.have.length(3); // root, ca, cb
      expect(new Set(made.map((m) => m.cache)).size).to.equal(3);
      expect(made.map((m) => m.opts?.maxEntries)).to.deep.equal([10000, 7, 10000]);
      expect(typeof made[1].opts?.clock).to.equal('function');

      for (const svc of [ca, cb]) {
        await svc.check({ principal: alice, permission: 'doc:read', resource: doc1 });
        await svc.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      }
      expect(count(ma, 'evaluate')).to.equal(1);
      expect(count(mb, 'evaluate')).to.equal(1);

      ca.invalidate(['subject:user:alice']);
      await ca.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      await cb.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      expect(count(ma, 'evaluate')).to.equal(2);
      expect(count(mb, 'evaluate')).to.equal(1);

      await (await DI.resolve(ChangeBus)).publish(change());
      await ca.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      await cb.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      expect(count(ma, 'evaluate')).to.equal(3);
      expect(count(mb, 'evaluate')).to.equal(2);
    });
  });

  describe('principal, runAs and audit', () => {
    it('check without a principal uses current(); runAs sets it, preloads, audits and restores', async () => {
      const audit = new RecordingAudit();
      const m = allowing('jm');
      const d = await domains();
      const c = d.create('job');
      c.register(instance(m)).as(AuthorizationModel);
      c.register(instance(audit)).as(DecisionAudit);
      c.register(() => new MissingCache()).as(DecisionCache);
      const svc = await d.service('job');

      expect(svc.current()).to.equal(UNATTENDED);
      const denied = await svc.check({ permission: 'doc:read', resource: doc1 } as never);
      expect(denied.allowed).to.equal(false);
      expect(count(m, 'evaluate')).to.equal(0);

      const out = await svc.runAs(alice, 'nightly', async () => {
        expect(svc.current()).to.equal(alice);
        const a = await svc.check({ permission: 'doc:read', resource: doc1 } as never);
        const b = await svc.check({ permission: 'doc:read', resource: doc1 } as never);
        expect(requestScope().cache!.size).to.be.greaterThan(0);
        return [a.allowed, b.allowed];
      });
      expect(out).to.deep.equal([true, true]);
      // the second check came from the request L1: the L2 of this domain never hits
      expect(count(m, 'evaluate')).to.equal(1);
      expect(m.requests[0].principal).to.equal(alice);
      expect(svc.current()).to.equal(UNATTENDED);

      expect(audit.of('runAs')).to.have.length(1);
      expect(audit.of('runAs')[0]).to.deep.include({ kind: 'runAs', reason: 'nightly' });
      expect(audit.of('runAs')[0].principal).to.deep.equal({ type: 'user', id: 'alice' });
      expect(count(m, 'preload')).to.equal(1);
      expect(m.calls.find((x) => x.method === 'preload')!.args[0]).to.equal(alice);

      await svc.runAs(SYSTEM, 'maintenance', async () => {
        expect(svc.current()).to.equal(SYSTEM);
      });
      expect(count(m, 'preload')).to.equal(1);
      expect(audit.of('runAs')).to.have.length(2);

      for (const reason of ['', '   ', undefined, 42]) {
        const err = await rejection(svc.runAs(alice, reason as never, async () => 1));
        expect(err).to.be.instanceOf(AuthzConfigError);
      }
      expect(await rejection(svc.runAs(null as never, 'x', async () => 1))).to.be.instanceOf(AuthzConfigError);
      expect(audit.of('runAs')).to.have.length(2);
    });

    it('does not audit runAs when authz.audit.runAs is false; a failing audit does not fail runAs', async () => {
      setConfig(['authz', 'domains', 'quiet', 'audit'], { runAs: false });
      const quietAudit = new RecordingAudit();
      const d = await domains();
      d.create('quiet').register(instance(quietAudit)).as(DecisionAudit);
      const quiet = await d.service('quiet');
      expect(await quiet.runAs(alice, 'x', async () => 5)).to.equal(5);
      expect(quietAudit.of('runAs')).to.have.length(0);

      class Failing extends DecisionAudit {
        record(): Promise<void> {
          return Promise.reject(new Error('audit down'));
        }
      }
      d.create('loud').register(instance(new Failing())).as(DecisionAudit);
      const loud = await d.service('loud');
      expect(await loud.runAs(alice, 'x', async () => 6)).to.equal(6);
    });

    it('a configured audit service picks the registration by name; an unknown name fails boot', async () => {
      class NamedAudit extends RecordingAudit {}
      class OtherAudit extends RecordingAudit {}
      setConfig(['authz', 'domains', 'na', 'audit'], { service: 'NamedAudit' });
      const d = await domains();
      const c = d.create('na');
      c.register(NamedAudit).as(DecisionAudit);
      c.register(OtherAudit).as(DecisionAudit);
      const na = await d.service('na');
      await na.runAs(alice, 'pick', async () => undefined);
      expect(c.get(NamedAudit)!.of('runAs')).to.have.length(1);
      // only the chosen registration is resolved
      expect(c.get(OtherAudit)).to.equal(undefined);

      setConfig(['authz', 'domains', 'nb', 'audit'], { service: 'Missing' });
      d.create('nb');
      const err = await rejection(d.service('nb'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('"nb"').and.contain('Missing');
    });
  });

  describe('change bus', () => {
    it('routes changes by domain', async () => {
      const d = await domains();
      const fsModel = silent('fsm');
      d.create('fs').register(instance(fsModel)).as(AuthorizationModel);
      setConfig(['authz', 'domains', 'fs.sub'], { parent: 'fs' });
      d.create('fs.sub');
      d.create('other');
      const root = await rootService();
      const fs = await d.service('fs');
      const sub = await d.service('fs.sub');
      const other = await d.service('other');
      const spies = { root: spyInvalidate(root), fs: spyInvalidate(fs), sub: spyInvalidate(sub), other: spyInvalidate(other) };
      const bus = await DI.resolve(ChangeBus);
      const counts = () => Object.fromEntries(Object.entries(spies).map(([k, v]) => [k, v.length]));

      await bus.publish(change());
      expect(counts()).to.deep.equal({ root: 1, fs: 1, sub: 1, other: 1 });
      expect(fsModel.invalidations.length).to.be.greaterThan(0);

      await bus.publish(change('fs'));
      expect(counts()).to.deep.equal({ root: 1, fs: 2, sub: 2, other: 1 });

      await bus.publish(change('root'));
      expect(counts()).to.deep.equal({ root: 2, fs: 3, sub: 3, other: 2 });

      await bus.publish(change('fs.sub'));
      expect(counts()).to.deep.equal({ root: 2, fs: 3, sub: 4, other: 2 });
      expect(spies.sub[3]).to.deep.equal(['subject:user:alice']);
    });
  });

  describe('dispose', () => {
    it('disposes own models once, children first, unsubscribes and detaches', async () => {
      const order: string[] = [];
      class Ordered extends StaticModel {
        async dispose(): Promise<void> {
          order.push(this.name);
          await super.dispose();
        }
      }
      const rm = new Ordered({ name: 'rm' });
      registerInRoot(AuthorizationModel, instance(rm));
      const mp = new Ordered({ name: 'mp' });
      const mc = new Ordered({ name: 'mc' });
      setConfig(['authz', 'domains', 'p.c'], { parent: 'p' });
      const d = await domains();
      d.create('p').register(instance(mp)).as(AuthorizationModel);
      d.create('p.c').register(instance(mc)).as(AuthorizationModel);
      const p = await d.service('p');
      const pc = await d.service('p.c');
      expect(authz('p')).to.equal(p);
      expect(authz('p.c')).to.equal(pc);
      const spyP = spyInvalidate(p);
      const spyC = spyInvalidate(pc);

      await d.container('p').dispose();
      expect(order).to.deep.equal(['mc', 'mp']);
      expect(count(mp, 'dispose')).to.equal(1);
      expect(count(mc, 'dispose')).to.equal(1);
      expect(count(rm, 'dispose')).to.equal(0);
      expect(d.names()).to.deep.equal(['root']);
      expect(() => authz('p')).to.throw(AuthzConfigError);
      expect(() => authz('p.c')).to.throw(AuthzConfigError);

      await (await DI.resolve(ChangeBus)).publish(change());
      expect(spyP).to.have.length(0);
      expect(spyC).to.have.length(0);

      await p.dispose();
      expect(count(mp, 'dispose')).to.equal(1);
      expect(() => p.models()).to.throw(AuthzConfigError);

      await resetRoot();
      expect(count(rm, 'dispose')).to.equal(1);
    });
  });

  describe('admin', () => {
    it('throws without an AuthzAdmin and returns the registered one', async () => {
      const root = await rootService();
      expect(() => root.admin()).to.throw(AuthzConfigError, /no AuthzAdmin is registered in domain "root"/);
      const fake = { fake: true } as unknown as AuthzAdmin;
      const d = await domains();
      d.create('adm').register(instance(fake)).as(AuthzAdmin);
      expect((await d.service('adm')).admin()).to.equal(fake);
    });
  });

  describe('domain config', () => {
    it('engine, cache and permissions of a child reach its Authorizer', async () => {
      setConfig(['authz', 'domains', 'slow'], { engine: { modelTimeoutMs: 20 } });
      setConfig(['authz', 'domains', 'nol2'], { cache: { ttlSeconds: 0 }, permissions: { 'job:run': {} } });
      const d = await domains();
      d.create('slow')
        .register(instance(allowing('late', { delayMs: 150 })))
        .as(AuthorizationModel);
      d.create('patient')
        .register(instance(allowing('late2', { delayMs: 150 })))
        .as(AuthorizationModel);
      const nol2Model = allowing('n');
      const l2Model = allowing('l');
      d.create('nol2').register(instance(nol2Model)).as(AuthorizationModel);
      d.create('l2').register(instance(l2Model)).as(AuthorizationModel);

      expect(await (await d.service('slow')).can(alice, 'doc:read', doc1)).to.equal(false);
      expect(await (await d.service('patient')).can(alice, 'doc:read', doc1)).to.equal(true);

      const nol2 = await d.service('nol2');
      const l2 = await d.service('l2');
      for (let i = 0; i < 2; i++) {
        await nol2.check({ principal: alice, permission: 'doc:read', resource: doc1 });
        await l2.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      }
      expect(count(nol2Model, 'evaluate')).to.equal(2);
      expect(count(l2Model, 'evaluate')).to.equal(1);

      expect(await nol2.can(alice, 'job:run', { type: 'job', id: 'j' })).to.equal(true);
      expect(await rejection(l2.check({ principal: alice, permission: 'job:run', resource: { type: 'job', id: 'j' } }))).to.be.instanceOf(UnknownPermission);
    });
  });

  describe('methods', () => {
    it('assert, checkMany, filter, filterNow, explain, summary, covers, preload delegate to the engine', async () => {
      const d = await domains();
      const m = allowing('all');
      d.create('api').register(instance(m)).as(AuthorizationModel);
      const svc = await d.service('api');
      const bob = userPrincipal('bob');

      expect((await svc.assert(alice, 'doc:read', doc1)).allowed).to.equal(true);
      const many = await svc.checkMany(alice, ['doc:read', 'doc:write'], doc1);
      expect([...many.keys()]).to.deep.equal(['doc:read', 'doc:write']);
      expect((await svc.filter(alice, 'doc:read', 'doc')).op).to.equal('true');
      expect(svc.filterNow(alice, 'doc:read', 'doc')?.op).to.equal('true');
      const explained = await svc.explain({ principal: alice, permission: 'doc:read', resource: doc1 });
      expect(explained.trace).to.not.equal(undefined);
      const summary = await svc.summary(alice);
      expect(summary.principal).to.deep.equal({ type: 'user', id: 'alice' });
      expect(await svc.covers(alice, bob)).to.equal(false);
      await svc.preload(bob);
      expect(count(m, 'preload')).to.equal(1);

      const root = await rootService();
      const err = await rejection(root.assert(alice, 'doc:read', doc1));
      expect(err.name).to.equal('AccessDenied');
    });

    it('an explicit undefined principal meets the engine gate, never current()', async () => {
      const d = await domains();
      d.create('gate')
        .register(instance(allowing('g')))
        .as(AuthorizationModel);
      const svc = await d.service('gate');
      await svc.runAs(SYSTEM, 'job', async () => {
        const explicit = await svc.check({ principal: undefined, permission: 'doc:read', resource: doc1 } as never);
        expect(explicit.allowed).to.equal(false);
        expect(explicit.reason?.code).to.equal('unattended');
        expect((await svc.explain({ principal: undefined, permission: 'doc:read', resource: doc1 } as never)).allowed).to.equal(false);
        expect((await svc.check({ permission: 'doc:read', resource: doc1 } as never)).allowed).to.equal(true);
        const inherited = Object.assign(Object.create({ principal: undefined }) as object, { permission: 'doc:read', resource: doc1 });
        const viaPrototype = await svc.check(inherited as never);
        expect(viaPrototype.allowed).to.equal(false);
        expect(viaPrototype.reason?.code).to.equal('unattended');
      });
      await svc.runAs(alice, 'job', async () => {
        expect(await svc.can(undefined as never, 'doc:read', doc1)).to.equal(false);
        expect(await rejection(svc.assert(undefined as never, 'doc:read', doc1))).to.have.property('name', 'AccessDenied');
      });
    });
  });

  describe('disposal while booting', () => {
    it('a domain container disposed before the service attaches: the boot fails and leaves nothing', async () => {
      const started = gate();
      const release = gate();
      const m = new GatedModel({ name: 'gm' }, { started: started.open, release: release.promise });
      const bus = new CountingBus();
      const d = await domains();
      const c = d.create('mid');
      c.register(instance(m)).as(AuthorizationModel);
      c.register(instance(bus)).as(ChangeBus);

      const pending = d.service('mid');
      await started.promise;
      expect(bus.subscribers.size).to.equal(1);
      await c.dispose();
      release.open();
      const err = await rejection(pending);
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('"mid"');
      await tick();
      expect(() => authz('mid')).to.throw(AuthzConfigError);
      expect(bus.subscribers.size).to.equal(0);
      expect(count(m, 'dispose')).to.equal(1);
      expect(d.names()).to.deep.equal(['root']);
    });

    it('a domain container disposed after attach, before DI caches the service: it is disposed and service() rejects', async () => {
      const m = allowing('lm');
      const bus = new CountingBus();
      const d = await domains();
      const c = d.create('late');
      c.register(instance(m)).as(AuthorizationModel);
      c.register(instance(bus)).as(ChangeBus);

      await patched(
        d,
        'attach',
        (original) => (name, svc) => {
          const ok = original(name, svc);
          if (name === 'late') void c.dispose();
          return ok;
        },
        async () => {
          const err = await rejection(d.service('late'));
          expect(err).to.be.instanceOf(AuthzConfigError);
          expect(err.message).to.contain('"late"');
        },
      );
      await tick();
      expect(() => authz('late')).to.throw(AuthzConfigError);
      expect(bus.subscribers.size).to.equal(0);
      expect(count(m, 'dispose')).to.equal(1);
      await bus.publish(change());
      expect(m.invalidations).to.have.length(0);
    });

    it('svc.dispose() during its boot: the boot fails, nothing stays attached, a later resolve boots again', async () => {
      const started = gate();
      const release = gate();
      const m = new GatedModel({ name: 'dm', votes: { '*': { permitWhen: TRUE } } }, { started: started.open, release: release.promise });
      const bus = new CountingBus();
      const d = await domains();
      const c = d.create('self');
      c.register(instance(m)).as(AuthorizationModel);
      c.register(instance(bus)).as(ChangeBus);

      let booting: AuthzService | undefined;
      await patched(
        d,
        'enter',
        (original) => (container: IContainer, svc) => {
          if (container === c) booting = svc;
          return original(container, svc);
        },
        async () => {
          const pending = d.service('self');
          await started.promise;
          await booting!.dispose();
          // unsubscribed at once, though the init has not finished
          expect(bus.subscribers.size).to.equal(0);
          release.open();
          const err = await rejection(pending);
          expect(err).to.be.instanceOf(AuthzConfigError);
          expect(err.message).to.match(/disposed while it booted/);
        },
      );
      expect(d.resolved('self')).to.equal(undefined);
      expect(bus.subscribers.size).to.equal(0);
      expect(count(m, 'dispose')).to.equal(1);

      const svc = await d.service('self');
      expect(svc).to.not.equal(booting);
      expect(count(m, 'init')).to.equal(2);
      expect(await svc.can(alice, 'doc:read', doc1)).to.equal(true);
    });
  });

  describe('boot details', () => {
    it('changes published while a domain boots are applied once when the boot ends', async () => {
      const bus = new CountingBus();
      const m = new GatedModel(
        { name: 'cm' },
        {
          during: async () => {
            const reused = ['subject:user:alice'];
            await bus.publish(change(undefined, reused));
            reused.length = 0;
            await bus.publish(change('other-domain', ['subject:user:carol']));
            await bus.publish(change('buf', ['subject:user:bob']));
          },
        },
      );
      const d = await domains();
      const c = d.create('buf');
      c.register(instance(m)).as(AuthorizationModel);
      c.register(instance(bus)).as(ChangeBus);
      await d.service('buf');
      expect(m.invalidations).to.deep.equal([['subject:user:alice', 'subject:user:bob']]);
    });

    it('keeps copied, frozen permission defs for the child replay', async () => {
      const defs: { name: string; resource: string; action: string; types: string[] }[] = [{ name: 'thing:read', resource: 'thing', action: 'read', types: ['thing'] }];
      class MutatingAdapter extends ResourceAdapter {
        readonly kind = 'mut';
        readonly types = ['thing'];
        accepts(_t: unknown): _t is never {
          return false;
        }
        refOf(): never {
          throw new Error('unused');
        }
        async ancestors() {
          return null;
        }
        permissions() {
          return defs;
        }
      }
      setConfig(['authz', 'domains', 'pp.c'], { parent: 'pp' });
      const d = await domains();
      d.create('pp').register(instance(new MutatingAdapter())).as(ResourceAdapter);
      d.create('pp.c');
      const pp = await d.service('pp');
      defs[0].types.push('other');
      defs.push({ name: 'thing:write', resource: 'thing', action: 'write', types: ['thing'] });

      const kept = (pp as unknown as { booted: { registrations: { defs: readonly { name: string; types: readonly string[] }[]; source: string }[] } }).booted.registrations.find((r) => r.source === 'adapter:mut')!;
      expect(kept.defs).to.deep.equal([{ name: 'thing:read', resource: 'thing', action: 'read', types: ['thing'] }]);
      expect(Object.isFrozen(kept.defs) && Object.isFrozen(kept.defs[0]) && Object.isFrozen(kept.defs[0].types)).to.equal(true);

      const child = await d.service('pp.c');
      expect(await rejection(child.check({ principal: alice, permission: 'thing:write', resource: { type: 'thing', id: 't' } }))).to.be.instanceOf(UnknownPermission);
      expect(await child.can(alice, 'thing:read', { type: 'thing', id: 't' })).to.equal(false);
    });

    it('a failed boot leaves no subscription and disposes the model only it used', async () => {
      setConfig(['authz', 'domains', 'fail'], { combine: { default: { algorithm: 'deny-overrides', models: ['nope'] } } });
      const m = allowing('fm');
      const bus = new CountingBus();
      const d = await domains();
      const c = d.create('fail');
      c.register(instance(m)).as(AuthorizationModel);
      c.register(instance(bus)).as(ChangeBus);
      expect(await rejection(d.service('fail'))).to.be.instanceOf(AuthzConfigError);
      expect(bus.subscribers.size).to.equal(0);
      expect(count(m, 'init')).to.equal(1);
      expect(count(m, 'dispose')).to.equal(1);
    });

    it('cache.maxEntries 0 gives no L2', async () => {
      setConfig(['authz', 'domains', 'nocache', 'cache'], { maxEntries: 0 });
      let made = 0;
      const m = allowing('nc');
      const d = await domains();
      const c = d.create('nocache');
      c.register(instance(m)).as(AuthorizationModel);
      c.register((_c: unknown, opts?: LruDecisionCacheOptions) => {
        made++;
        return new LruDecisionCache(opts ?? {});
      }).as(DecisionCache);
      const svc = await d.service('nocache');
      await svc.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      await svc.check({ principal: alice, permission: 'doc:read', resource: doc1 });
      expect(made).to.equal(0);
      expect(count(m, 'evaluate')).to.equal(2);
    });

    it('a DecisionCache instance used by one Authorizer is never adopted by another, even after disposal', async () => {
      const shared = new LruDecisionCache();
      const d = await domains();
      d.create('s1').register(instance(shared)).as(DecisionCache);
      d.create('s2').register(instance(shared)).as(DecisionCache);
      await d.service('s1');
      const err = await rejection(d.service('s2'));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message)
        .to.contain('"s2"')
        .and.match(/already used/);

      await d.container('s1').dispose();
      d.create('s3').register(instance(shared)).as(DecisionCache);
      expect(await rejection(d.service('s3'))).to.be.instanceOf(AuthzConfigError);
    });

    it('authz.bus.service picks the bus class by name and builds only that one', async () => {
      class NamedBus extends CountingBus {}
      class OtherBus extends CountingBus {}
      registerInRoot(ChangeBus, NamedBus);
      registerInRoot(ChangeBus, OtherBus);
      setConfig('authz.bus.service', 'NamedBus');
      try {
        await rootService();
        expect(DI.RootContainer.get(NamedBus)!.subscribers.size).to.equal(1);
        expect(DI.RootContainer.Cache.has(OtherBus)).to.equal(false);
      } finally {
        await resetRoot();
        DI.uncache(NamedBus);
      }

      setConfig('authz.bus.service', 'Missing');
      const err = await rejection(rootService());
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain('"root"').and.contain('Missing');
    });
  });
});
