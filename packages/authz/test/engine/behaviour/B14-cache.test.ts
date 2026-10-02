import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions, RequestScope } from '../../../src/engine/authorizer.js';
import { LruDecisionCache } from '../../../src/engine/cache.js';
import { runAsync } from '../../../src/engine/run.js';
import { FALSE, SYSTEM, ScopeAttributeStore, TRUE, resourceKey } from '../../../src/index.js';
import type { CheckInput, Decision, DecisionRequest, EvaluationContext, Principal, ResourceFilter, ResourceRef, Vote } from '../../../src/index.js';
import { FakeAdapter, FakeRow, FakeScopeResolver, RecordingAudit, RecordingLog, StaticModel, deny, fakeClock, permit, principal, registryOf } from '../fakes.js';
import type { FakeClock } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'doc:write', types: ['doc'] },
  { name: 'folder:read', types: ['folder'] },
]);
const ref = (r: string) => ({ ref: r });
const eq = (field: string, value: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value } as ResourceFilter);
const pass = (model: string, permitWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen, denyWhen: FALSE, cacheable: true, ...extra });

const F1: ResourceRef = { type: 'folder', id: 'f1' };
const F2: ResourceRef = { type: 'folder', id: 'f2' };
const D1: ResourceRef = { type: 'doc', id: 'd1' };
const D2: ResourceRef = { type: 'doc', id: 'd2' };
const rows = () => [new FakeRow('doc', 'd1', {}, F1), new FakeRow('doc', 'd2', {}, F2), new FakeRow('folder', 'f1'), new FakeRow('folder', 'f2')];

/** A real LRU that records what the engine asks of it. */
class RecordingCache extends LruDecisionCache {
  readonly sets: { readonly key: string; readonly decision: Decision; readonly tags: readonly string[]; readonly ttlMs: number }[] = [];
  readonly gets: string[] = [];
  readonly invalidations: (readonly string[])[] = [];

  get(key: string): Decision | undefined {
    this.gets.push(key);
    return super.get(key);
  }

  set(key: string, d: Decision, tags: readonly string[], ttlMs: number): void {
    this.sets.push({ key, decision: d, tags, ttlMs });
    super.set(key, d, tags, ttlMs);
  }

  invalidate(tags: readonly string[]): void {
    this.invalidations.push(tags);
    super.invalidate(tags);
  }
}

interface Setup {
  readonly a: Authorizer;
  readonly cache: RecordingCache;
  readonly clock: FakeClock;
  readonly audit: RecordingAudit;
  readonly log: RecordingLog;
}

const setup = (models: StaticModel[], options: Partial<AuthorizerOptions> & { l2?: boolean } = {}): Setup => {
  const clock = fakeClock();
  const audit = new RecordingAudit();
  const log = new RecordingLog();
  const cache = new RecordingCache({ clock: clock.clock });
  const { l2 = true, ...rest } = options;
  const a = new Authorizer({ domain: 'root', registry, models, adapters: [new FakeAdapter(['doc', 'folder'], { rows: rows() })], clock: clock.clock, audit, log, ...(l2 ? { cache } : {}), ...rest });
  return { a, cache, clock, audit, log };
};

const alice = principal('user', 'alice');
const bob = principal('user', 'bob');
const read = (p: Principal = alice, resource?: ResourceRef, extra: Partial<CheckInput> = {}): CheckInput => ({ principal: p, permission: 'doc:read', ...(resource ? { resource } : {}), ...extra });
/** A fresh request scope per call: only the L2 can answer twice. */
const fresh = (): RequestScope => ({ cache: new Map<string, unknown>() });
const pipelineOf = (a: Authorizer, input: CheckInput): Promise<{ readonly decision: Decision; readonly uncacheable: boolean }> => runAsync((a as any)['pipeline'](input, (a as any)['newRun'](false, undefined)));

describe('B14: decision caches (L1 per request, L2 across requests)', () => {
  describe('L2', () => {
    it('B14: a second request is answered from the L2 without running the models', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a, cache } = setup([m]);
      const first = await a.check(read(alice, D1), fresh());
      const second = await a.check(read(alice, D1), fresh());
      expect(m.calls).to.have.length(1);
      expect(second).to.equal(first);
      expect(cache.sets).to.have.length(1);
      expect(cache.sets[0].tags).to.include.members(['*', 'model:m', 'subject:user:alice', 'scope:doc:d1', 'scope:folder:f1', 'scope:$global']);
    });

    it('B14: validUntil is the earliest expiry; the TTL never outlives it nor cacheTtlSeconds', async () => {
      const at = (s: number, c: FakeClock) => new Date(c.now.getTime() + s * 1000);
      const clock = fakeClock();
      const m1 = new StaticModel('m1', { vote: () => pass('m1', TRUE, { validUntil: at(30, clock) }) });
      const m2 = new StaticModel('m2', { vote: () => pass('m2', TRUE, { validUntil: at(10, clock) }) });
      const cache = new RecordingCache({ clock: clock.clock });
      const a = new Authorizer({ domain: 'root', registry, models: [m1, m2], clock: clock.clock, cache });
      const capped = principal('user', 'alice', { ceiling: { expiresAt: at(20, clock) } });
      const d = await a.check(read(capped), fresh());
      expect(d.validUntil?.getTime()).to.equal(at(10, clock).getTime());
      expect(cache.sets).to.have.length(1);
      expect(cache.sets[0].ttlMs).to.equal(10_000);

      const short = new RecordingCache({ clock: clock.clock });
      const b = new Authorizer({ domain: 'root', registry, models: [m1, m2], clock: clock.clock, cache: short, config: { cacheTtlSeconds: 5 } });
      await b.check(read(capped), fresh());
      expect(short.sets[0].ttlMs).to.equal(5_000);

      // Once validUntil passes, the entry is gone.
      clock.advance(10_000);
      await a.check(read(capped), fresh());
      expect(m1.calls).to.have.length(3);
    });

    it('B14: an expired contributor gives validUntil in the past, and nothing is cached', async () => {
      const clock = fakeClock();
      const past = new Date(clock.now.getTime() - 1000);
      const m1 = new StaticModel('m1', { vote: () => pass('m1', TRUE, { validUntil: past }) });
      const m2 = new StaticModel('m2', { vote: () => pass('m2', TRUE, { validUntil: new Date(clock.now.getTime() + 60_000) }) });
      const cache = new RecordingCache({ clock: clock.clock });
      const a = new Authorizer({ domain: 'root', registry, models: [m1, m2], clock: clock.clock, cache });
      const scope = fresh();
      const d = await a.check(read(), scope);
      expect(d.validUntil?.getTime()).to.equal(past.getTime());
      await a.check(read(), scope);
      expect(cache.sets).to.have.length(0);
      expect(m1.calls).to.have.length(2);
    });

    it('B14: cacheTtlSeconds 0 caches nothing, in either level', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a, cache } = setup([m], { config: { cacheTtlSeconds: 0 } });
      const scope = fresh();
      await a.check(read(), scope);
      await a.check(read(), scope);
      expect(cache.sets).to.have.length(0);
      expect(m.calls).to.have.length(2);
    });

    it('B14: invalidation by subject drops that principal only; the models get the original tags', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a, cache } = setup([m]);
      await a.check(read(alice, D1), fresh());
      await a.check(read(bob, D1), fresh());
      a.invalidate(['subject:user:alice']);
      expect(cache.invalidations.at(-1)).to.deep.equal(['subject:user:alice']);
      expect(m.invalidations).to.deep.equal([['subject:user:alice']]);
      await a.check(read(alice, D1), fresh());
      await a.check(read(bob, D1), fresh());
      expect(m.calls.map((c) => c.req.principal.id)).to.deep.equal(['alice', 'bob', 'alice']);
    });

    it('B14: invalidation by scope drops entries under that node and every type-level entry', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a, cache } = setup([m]);
      await a.check(read(alice, D1), fresh());
      await a.check(read(alice, D2), fresh());
      await a.check(read(alice), fresh());
      a.invalidate(['scope:folder:f1']);
      expect(cache.invalidations.at(-1)).to.deep.equal(['scope:*', 'scope:folder:f1']);
      await a.check(read(alice, D1), fresh());
      await a.check(read(alice, D2), fresh());
      await a.check(read(alice), fresh());
      expect(m.calls.map((c) => resourceKey(c.req.resource))).to.deep.equal(['doc:d1', 'doc:d2', 'doc', 'doc:d1', 'doc']);
    });

    it('B14: invalidation by model drops the entries routed through it', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const n = new StaticModel('n', { vote: permit() });
      const { a } = setup([m, n], { combine: { default: { algorithm: 'deny-overrides' }, types: { doc: { algorithm: 'deny-overrides', models: ['m'] }, folder: { algorithm: 'deny-overrides', models: ['n'] } } } });
      const folder: CheckInput = { principal: alice, permission: 'folder:read', resource: F1 };
      await a.check(read(alice, D1), fresh());
      await a.check(folder, fresh());
      a.invalidate(['model:m']);
      await a.check(read(alice, D1), fresh());
      await a.check(folder, fresh());
      expect(m.calls).to.have.length(2);
      expect(n.calls).to.have.length(1);
    });

    it('B14: an unknown tag (role, policy, anything else) drops the whole domain', async () => {
      for (const tag of ['role:viewer', 'policy:p1', 'rule:r', 'whatever']) {
        const m = new StaticModel('m', { vote: permit() });
        const { a, cache } = setup([m]);
        await a.check(read(alice, D1), fresh());
        await a.check(read(bob), fresh());
        a.invalidate([tag]);
        expect(cache.invalidations.at(-1), tag).to.deep.equal(['*']);
        expect(m.invalidations, tag).to.deep.equal([[tag]]);
        await a.check(read(alice, D1), fresh());
        await a.check(read(bob), fresh());
        expect(m.calls, tag).to.have.length(4);
      }
    });

    it('B14: a version change recompiles the routes and drops every entry', async () => {
      let version = 'v1';
      class Versioned extends StaticModel {
        version(): string {
          return version;
        }
      }
      const m = new Versioned('m', { vote: permit() });
      const { a, cache } = setup([m]);
      const before = a.routes();
      await a.check(read(), fresh());
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(1);
      version = 'v2';
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(2);
      expect(cache.invalidations).to.deep.include(['*']);
      expect(a.routes()).to.not.equal(before);
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(2);
    });

    it('B14: a version() that throws turns caching off for the call, logged once at warn', async () => {
      let broken = true;
      class Flaky extends StaticModel {
        version(): string {
          if (broken) throw new Error('no version');
          return 'v1';
        }
      }
      const m = new Flaky('m', { vote: permit() });
      const { a, cache, log } = setup([m]);
      const scope = fresh();
      await a.check(read(), scope);
      await a.check(read(), scope);
      expect(m.calls).to.have.length(2);
      expect(cache.sets).to.have.length(0);
      expect(log.at('warn')).to.have.length(1);
      broken = false;
      await a.check(read(), fresh());
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(3);
    });

    it('B14: a non-cacheable vote is never served from the L2, also from an intersect delegate', async () => {
      const m = new StaticModel('m', { vote: permit(TRUE, { cacheable: false }) });
      const ok = new StaticModel('ok', { vote: permit() });
      const { a, cache } = setup([ok, m]);
      await a.check(read(), fresh());
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(2);
      expect(cache.sets).to.have.length(0);

      // Only bob's (the delegate's) vote is non-cacheable: neither decision is stored.
      const byPrincipal = new StaticModel('m', { vote: (req: DecisionRequest) => pass('m', TRUE, { cacheable: req.principal.id !== 'bob' }) });
      const d = setup([byPrincipal]);
      const token = principal('token', 't1', { onBehalfOf: bob });
      await d.a.check(read(token), fresh());
      await d.a.check(read(token), fresh());
      expect(byPrincipal.calls.map((c) => c.req.principal.id)).to.deep.equal(['bob', 't1', 'bob', 't1']);
      expect(d.cache.sets).to.have.length(0);
    });

    it('B14: an invalidate that overlaps a check stops it from storing its decision', async () => {
      let a!: Authorizer;
      let during = true;
      const m = new StaticModel('m', {
        vote: async () => {
          await new Promise((r) => setTimeout(r, 5));
          // A revocation lands while this check still holds what it read.
          if (during) a.invalidate(['subject:user:bob']);
          return pass('m', TRUE);
        },
      });
      const s = setup([m]);
      a = s.a;
      const scope = fresh();
      expect((await a.check(read(), scope)).allowed).to.equal(true);
      expect(s.cache.sets).to.have.length(0);
      during = false;
      // The L1 entry of the overlapped check is dead too.
      await a.check(read(), scope);
      expect(m.calls).to.have.length(2);
      expect(s.cache.sets).to.have.length(1);
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(2);
    });

    it('B14: two principals that differ only in onBehalfOf, companions, attributes, authn or actor get different entries', async () => {
      const decide = (req: DecisionRequest): Vote => {
        const p = req.principal as Principal & Record<string, any>;
        const ok = p.id !== 'carol' && p.attributes?.team !== 'blue' && !(p.companions ?? []).some((c: Principal) => c.id === 'u2') && !(p.authn?.mfa ?? []).includes('none') && req.actor?.id !== 'evil';
        return pass('m', ok ? TRUE : FALSE);
      };
      const pairs: [string, CheckInput, CheckInput][] = [
        ['onBehalfOf', read(principal('token', 't1', { onBehalfOf: bob, delegation: 'intersect' })), read(principal('token', 't1', { onBehalfOf: principal('user', 'carol'), delegation: 'intersect' }))],
        ['companions', read(principal('link', 'l1', { companions: [principal('user', 'u1')] })), read(principal('link', 'l1', { companions: [principal('user', 'u2')] }))],
        ['attributes', read(principal('user', 'alice', { attributes: { team: 'red' } })), read(principal('user', 'alice', { attributes: { team: 'blue' } }))],
        ['authn', read(principal('user', 'alice', { authn: { method: 'password', mfa: ['totp'] } } as unknown as Partial<Principal>)), read(principal('user', 'alice', { authn: { method: 'password', mfa: ['none'] } } as unknown as Partial<Principal>))],
        ['actor', read(alice, undefined, { actor: principal('agent', 'good') }), read(alice, undefined, { actor: principal('agent', 'evil') })],
      ];
      for (const [what, allowedInput, deniedInput] of pairs) {
        const { a, cache } = setup([new StaticModel('m', { vote: decide })]);
        expect((await a.check(allowedInput, fresh())).allowed, what).to.equal(true);
        expect((await a.check(deniedInput, fresh())).allowed, what).to.equal(false);
        expect((await a.check(allowedInput, fresh())).allowed, what).to.equal(true);
        expect(new Set(cache.sets.map((s) => s.key)).size, what).to.be.at.least(2);
      }
    });

    it('B14: residuals that read identity or env are never cached', async () => {
      for (const r of ['principal.identity.sub', 'env.ip']) {
        const m = new StaticModel('m', { vote: permit(eq('x', ref(r))) });
        const { a, cache } = setup([m]);
        const who = principal('user', 'alice', { identity: { sub: 's1' } } as Partial<Principal>);
        await a.check(read(who, undefined, { env: { ip: '1.2.3.4' } }), fresh());
        await a.check(read(who, undefined, { env: { ip: '5.6.7.8' } }), fresh());
        expect(m.calls, r).to.have.length(2);
        expect(cache.sets, r).to.have.length(0);
      }
    });

    it('B14: a scope attribute load that timed out for a model only is not cached (probe P6, decision 18)', async () => {
      class Hung extends ScopeAttributeStore {
        get(): Promise<Readonly<Record<string, unknown>>> {
          return new Promise(() => undefined);
        }
        async version(): Promise<string> {
          return '1';
        }
      }
      const O1: ResourceRef = { type: 'org', id: 'o1' };
      const m1 = new StaticModel('m1', {
        vote: async (_req: DecisionRequest, ctx: EvaluationContext) => {
          void ctx.attributes(O1).catch(() => undefined);
          await new Promise((r) => setTimeout(r, 30));
          return pass('m1', FALSE);
        },
      });
      const m = new StaticModel('m', { vote: async (_req: DecisionRequest, ctx: EvaluationContext) => pass('m', (await ctx.attributes(O1)) === null ? eq('a', 1) : eq('a', 2)) });
      const clock = fakeClock();
      const cache = new RecordingCache({ clock: clock.clock });
      const options: AuthorizerOptions = {
        domain: 'root',
        registry,
        models: [m1, m],
        combine: { default: { algorithm: 'permit-overrides' } },
        adapters: [new FakeAdapter(['doc', 'folder'], { rows: [new FakeRow('doc', 'd1', {}, F1)], nodes: { 'folder:f1': O1, 'org:o1': null } })],
        scopeResolvers: [new FakeScopeResolver(['org'], { 'org:o1': null }, { 'org:o1': { plan: 'pro' } })],
        scopeAttributes: { schemas: [], store: new Hung() },
        log: new RecordingLog(),
        clock: clock.clock,
        cache,
        config: { modelTimeoutMs: 50 },
      };
      const a = new Authorizer(options);
      const d = await a.check(read(alice, D1), fresh());
      expect(d.residual).to.deep.equal(eq('a', 1));
      expect(cache.sets).to.have.length(0);
      expect((await pipelineOf(new Authorizer({ ...options, cache: undefined }), read(alice, D1))).uncacheable).to.equal(true);
    });

    it('B14: an L2 hit that is a denial is audited again; SYSTEM is never cached', async () => {
      const m = new StaticModel('m', { vote: deny() });
      const { a, cache, audit } = setup([m]);
      await a.check(read(), fresh());
      const d = await a.check(read(), fresh());
      expect(d.allowed).to.equal(false);
      expect(m.calls).to.have.length(1);
      expect(audit.kinds()).to.deep.equal(['deny', 'deny']);
      expect(audit.entries[1]).to.deep.include({ permission: 'doc:read', reason: 'no_access' });
      expect(audit.entries[1].principal).to.deep.equal({ type: 'user', id: 'alice' });

      await a.check(read(SYSTEM), fresh());
      expect(cache.sets).to.have.length(1);
      expect(audit.kinds()).to.deep.equal(['deny', 'deny', 'system']);
    });

    it('B14: explain and checks with a subject neither read nor write the caches', async () => {
      const m = new StaticModel('m', { vote: permit(eq('owner', 'alice')) });
      const { a, cache } = setup([m]);
      await a.check(read(), fresh());
      expect(cache.sets).to.have.length(1);
      const gets = cache.gets.length;
      const explained = await a.explain(read(), fresh());
      expect(explained.trace).to.not.equal(undefined);
      await a.check(read(alice, D1, { subject: { owner: 'alice' } }), fresh());
      expect(cache.gets).to.have.length(gets);
      expect(cache.sets).to.have.length(1);
      expect(m.calls).to.have.length(3);
    });

    it("B14: a model's nested ctx.check tags the outer entry with the nested principal", async () => {
      const m = new StaticModel('m', {
        vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'bob') return pass('m', TRUE);
          const theirs = await ctx.check({ principal: bob, permission: 'doc:read', resource: req.resource, env: {} });
          return pass('m', theirs.allowed ? TRUE : FALSE);
        },
      });
      const { a, cache } = setup([m]);
      await a.check(read(alice, D1), fresh());
      const outer = cache.sets.find((s) => s.decision.principal.id === 'alice');
      expect(outer?.tags).to.include('subject:user:bob');
      a.invalidate(['subject:user:bob']);
      await a.check(read(alice, D1), fresh());
      expect(m.calls.filter((c) => c.req.principal.id === 'alice')).to.have.length(2);
    });

    it('B14: a nested ctx.check that is not cacheable keeps the outer decision out of the caches', async () => {
      const m = new StaticModel('m', {
        vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'bob') return pass('m', TRUE, { cacheable: false });
          return pass('m', (await ctx.check({ principal: bob, permission: 'doc:read', resource: req.resource, env: {} })).allowed ? TRUE : FALSE);
        },
      });
      const { a, cache } = setup([m]);
      await a.check(read(alice, D1), fresh());
      await a.check(read(alice, D1), fresh());
      expect(cache.sets).to.have.length(0);
      expect(m.calls.filter((c) => c.req.principal.id === 'alice')).to.have.length(2);
    });

    it('B14: a nested decision served from the L2 tags the outer entry with scope:*, as its scope nodes are unknown', async () => {
      const m = new StaticModel('m', {
        vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'bob') return pass('m', TRUE);
          return pass('m', (await ctx.check({ principal: bob, permission: 'doc:read', resource: req.resource, env: {} })).allowed ? TRUE : FALSE);
        },
      });
      const { a, cache } = setup([m]);
      await a.check(read(bob, D1), fresh());
      expect(cache.sets[0].tags).to.not.include('scope:*');
      await a.check(read(alice, D1), fresh());
      const outer = cache.sets.find((s) => s.decision.principal.id === 'alice');
      expect(outer?.tags).to.include.members(['scope:*', 'subject:user:bob', 'subject:user:alice']);
    });

    it('B14: a cached decision that does not match the check, or a cache that throws, never answers', async () => {
      const m = new StaticModel('m', { vote: deny() });
      const clock = fakeClock();
      const log = new RecordingLog();
      const forged = { allowed: true, permission: 'doc:read', resource: { type: 'doc' }, principal: { type: 'user', id: 'mallory' }, residual: TRUE, fields: { read: ['*'], write: ['*'] }, roles: {}, domain: 'root' };
      class Lying extends LruDecisionCache {
        get(): Decision | undefined {
          return forged as Decision;
        }
      }
      const a = new Authorizer({ domain: 'root', registry, models: [m], clock: clock.clock, log, cache: new Lying() });
      expect((await a.check(read(), fresh())).allowed).to.equal(false);
      expect(log.at('warn').some((e) => /ignored a cached decision/.test(e.message))).to.equal(true);

      class Broken extends LruDecisionCache {
        get(): Decision | undefined {
          throw new Error('cache down');
        }
        set(): void {
          throw new Error('cache down');
        }
        invalidate(): void {
          throw new Error('cache down');
        }
      }
      const b = new Authorizer({ domain: 'root', registry, models: [m], clock: clock.clock, log, cache: new Broken() });
      expect((await b.check(read(), fresh())).allowed).to.equal(false);
      b.invalidate(['subject:user:alice']);
      expect(m.invalidations).to.have.length(1);
      expect(log.at('error').filter((e) => /decision cache failed/.test(e.message))).to.have.length(3);
      expect(() => new Authorizer({ domain: 'root', registry, models: [m], cache: { get() {} } as unknown as LruDecisionCache })).to.throw(/cache must be a DecisionCache/);
    });

    it('B14: a field combination fault is not cached (wiring step 8 review M4)', async () => {
      const negations = ['*', ...Array.from({ length: 300 }, (_, i) => `!*.f${i}`)];
      const subtrees = Array.from({ length: 300 }, (_, i) => `M${i}.*`);
      const { a } = setup([new StaticModel('a', { vote: permit(TRUE, { fields: { read: negations } }) }), new StaticModel('b', { vote: permit(TRUE, { fields: { read: subtrees } }) })]);
      const r = await pipelineOf(a, read());
      expect(r.decision.reason).to.deep.equal({ code: 'model_error' });
      expect(r.uncacheable).to.equal(true);
    });
  });

  describe('L1', () => {
    it('B14: a shared request scope answers the same check once, and a denial is audited once', async () => {
      const m = new StaticModel('m', { vote: deny() });
      const { a, audit } = setup([m], { l2: false });
      const scope = fresh();
      const first = await a.check(read(alice, D1), scope);
      const second = await a.check(read(alice, D1), scope);
      expect(second).to.equal(first);
      expect(m.calls).to.have.length(1);
      expect(audit.kinds()).to.deep.equal(['deny']);
      // Another request evaluates again: there is no L2.
      await a.check(read(alice, D1), fresh());
      expect(m.calls).to.have.length(2);
      expect(audit.kinds()).to.deep.equal(['deny', 'deny']);
    });

    it('B14: checkMany, filter and filterNow share the L1 of one scope', async () => {
      const m = new StaticModel('m', { vote: permit(eq('team', 'red')) });
      const { a } = setup([m], { l2: false });
      const scope = fresh();
      await a.checkMany(alice, ['doc:read', 'doc:write'], undefined, scope);
      expect(await a.filter(alice, 'doc:read', 'doc', scope)).to.deep.equal(eq('team', 'red'));
      expect(a.filterNow(alice, 'doc:write', 'doc', scope)).to.deep.equal(eq('team', 'red'));
      expect(m.calls).to.have.length(2);
    });

    it('B14: an L2 hit fills the L1, so the same request does not audit it twice', async () => {
      const m = new StaticModel('m', { vote: deny() });
      const { a, audit, cache } = setup([m]);
      await a.check(read(), fresh());
      const scope = fresh();
      await a.check(read(), scope);
      await a.check(read(), scope);
      expect(audit.kinds()).to.deep.equal(['deny', 'deny']);
      expect(cache.gets).to.have.length(2);
    });

    it('B14: an L1 entry ends at validUntil, also inside one request', async () => {
      const clock = fakeClock();
      const m = new StaticModel('m', { vote: () => pass('m', TRUE, { validUntil: new Date(clock.now.getTime() + 10_000) }) });
      const a = new Authorizer({ domain: 'root', registry, models: [m], clock: clock.clock });
      const scope = fresh();
      await a.check(read(), scope);
      clock.advance(5_000);
      await a.check(read(), scope);
      expect(m.calls).to.have.length(1);
      clock.advance(6_000);
      await a.check(read(), scope);
      expect(m.calls).to.have.length(2);
    });

    it('B14: an invalidate drops what the L1 holds too', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a } = setup([m], { l2: false });
      const scope = fresh();
      await a.check(read(), scope);
      a.invalidate(['subject:user:alice']);
      await a.check(read(), scope);
      expect(m.calls).to.have.length(2);
    });

    it('B14: a non-cacheable decision is not kept in the L1 either', async () => {
      const m = new StaticModel('m', { vote: permit(eq('ip', ref('env.ip'))) });
      const { a } = setup([m], { l2: false });
      const scope = fresh();
      expect((await a.check(read(alice, undefined, { env: { ip: '1' } }), scope)).residual).to.deep.equal(eq('ip', '1'));
      expect((await a.check(read(alice, undefined, { env: { ip: '2' } }), scope)).residual).to.deep.equal(eq('ip', '2'));
      expect(m.calls).to.have.length(2);
    });

    it("B14: an intersect delegate's decision is cached under the delegate's own key", async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a } = setup([m], { l2: false });
      const scope = fresh();
      await a.check(read(principal('token', 't1', { onBehalfOf: bob })), scope);
      await a.check(read(bob), scope);
      expect(m.calls.map((c) => c.req.principal.id)).to.deep.equal(['bob', 't1']);
    });
  });
});
