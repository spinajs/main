import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions, RequestScope } from '../../../src/engine/authorizer.js';
import { LruDecisionCache } from '../../../src/engine/cache.js';
import { runAsync } from '../../../src/engine/run.js';
import { nestExpiry, newNested } from '../../../src/engine/support/misc.js';
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
      // The L1 entry of the overlapped check is dead too, and the scope that saw the invalidate stores nothing more.
      await a.check(read(), scope);
      expect(m.calls).to.have.length(2);
      expect(s.cache.sets).to.have.length(0);
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(3);
      expect(s.cache.sets).to.have.length(1);
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(3);
    });

    it('B14: two principals that differ only in onBehalfOf, companions, attributes, authn or actor get different entries', async () => {
      const decide = (req: DecisionRequest): Vote => {
        const p = req.principal as Principal & Record<string, any>;
        const ok = p.id !== 'carol' && p.attributes?.team !== 'blue' && !(p.companions ?? []).some((c) => c.id === 'u2') && !(p.authn?.mfa ?? []).includes('none') && req.actor?.id !== 'evil';
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

    describe('a decision resting on a nested ctx.check ends when the nested grant does', () => {
      const carol = principal('user', 'carol');
      const T0 = fakeClock().now.getTime();
      const expiry = new Date(T0 + 5_000);
      /** alice reads what bob may write, bob writes what carol may write; `grantee` holds a grant that ends at `expiry` (or never). */
      const chain = (clock: FakeClock, grantee: Principal, ends: boolean, effect: 'permit' | 'deny') =>
        new StaticModel('m', {
          vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
            if (req.principal.id === grantee.id) {
              const live = !ends || clock.now.getTime() < expiry.getTime();
              const until = ends && live ? { validUntil: expiry } : {};
              if (effect === 'deny') return live ? pass('m', FALSE, { denyWhen: TRUE, ...until }) : pass('m', TRUE);
              return pass('m', live ? TRUE : FALSE, until);
            }
            const next = req.principal.id === 'alice' ? bob : carol;
            return pass('m', (await ctx.check({ principal: next, permission: 'doc:write', resource: req.resource, env: {} })).allowed ? TRUE : FALSE);
          },
        });
      const built = (grantee: Principal, ends: boolean, options: { l2?: boolean } = {}, effect: 'permit' | 'deny' = 'permit') => {
        const clock = fakeClock();
        const cache = new RecordingCache({ clock: clock.clock });
        const models = [chain(clock, grantee, ends, effect)];
        const a = new Authorizer({ domain: 'root', registry, models, adapters: [new FakeAdapter(['doc', 'folder'], { rows: rows() })], clock: clock.clock, ...(options.l2 === false ? {} : { cache }) });
        return { a, cache, clock };
      };
      const outer = (cache: RecordingCache) => cache.sets.find((s) => s.decision.principal.id === 'alice');

      it('B14: in the L2 the outer entry lives no longer than the nested grant', async () => {
        const { a, cache, clock } = built(bob, true);
        const first = await a.check(read(alice, D1), fresh());
        expect(first.allowed).to.equal(true);
        clock.advance(6_000);
        expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(false);
        expect(first.validUntil?.getTime()).to.equal(expiry.getTime());
        expect(outer(cache)?.ttlMs).to.equal(5_000);
      });

      it('B14: in the L1 of one request the outer entry ends with the nested grant', async () => {
        const { a, clock } = built(bob, true, { l2: false });
        const scope = fresh();
        expect((await a.check(read(alice, D1), scope)).allowed).to.equal(true);
        clock.advance(6_000);
        expect((await a.check(read(alice, D1), scope)).allowed).to.equal(false);
      });

      for (const level of ['L1', 'L2'] as const) {
        it(`B14: a nested check answered from the ${level} bounds the outer entry too`, async () => {
          const { a, clock } = built(bob, true, { l2: level === 'L2' });
          const scope = fresh();
          await a.check({ principal: bob, permission: 'doc:write', resource: D1 }, level === 'L1' ? scope : fresh());
          expect((await a.check(read(alice, D1), scope)).allowed).to.equal(true);
          clock.advance(6_000);
          expect((await a.check(read(alice, D1), scope)).allowed).to.equal(false);
        });
      }

      it('B14: two levels down, the grant of the innermost check bounds the outer entry', async () => {
        const { a, cache, clock } = built(carol, true);
        expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(true);
        expect(outer(cache)?.ttlMs).to.equal(5_000);
        clock.advance(6_000);
        expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(false);
      });

      /** alice's own vote ends at `own`; it rests on bob's grant, which ends at `expiry`. */
      const ownAndNested = (own: Date) => {
        const clock = fakeClock();
        const cache = new RecordingCache({ clock: clock.clock });
        const m = new StaticModel('m', {
          vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
            if (req.principal.id === bob.id) return pass('m', TRUE, { validUntil: expiry });
            const d = await ctx.check({ principal: bob, permission: 'doc:write', resource: req.resource, env: {} });
            return pass('m', d.allowed ? TRUE : FALSE, { validUntil: own });
          },
        });
        const a = new Authorizer({ domain: 'root', registry, models: [m], adapters: [new FakeAdapter(['doc', 'folder'], { rows: rows() })], clock: clock.clock, cache });
        return { a, cache };
      };

      it('B14: an outer vote with a later expiry of its own still ends with the nested grant', async () => {
        const { a, cache } = ownAndNested(new Date(T0 + 9_000));
        expect((await a.check(read(alice, D1), fresh())).validUntil?.getTime()).to.equal(expiry.getTime());
        expect(outer(cache)?.ttlMs).to.equal(5_000);
      });

      it('B14: an outer vote with an earlier expiry of its own ends first', async () => {
        const { a, cache } = ownAndNested(new Date(T0 + 2_000));
        expect((await a.check(read(alice, D1), fresh())).validUntil?.getTime()).to.equal(T0 + 2_000);
        expect(outer(cache)?.ttlMs).to.equal(2_000);
      });

      it('B14: a nested deny that ends bounds the cached outer denial the same way', async () => {
        const { a, cache, clock } = built(bob, true, {}, 'deny');
        expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(false);
        expect(outer(cache)?.ttlMs).to.equal(5_000);
        clock.advance(6_000);
        expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(true);
      });

      it('B14: a nested check with no expiry shortens nothing, and the expiry leaves the nested tags as they were', async () => {
        const plain = built(bob, false);
        const d = await plain.a.check(read(alice, D1), fresh());
        expect(d.validUntil).to.equal(undefined);
        expect(outer(plain.cache)?.ttlMs).to.equal(60_000);
        const bounded = built(bob, true);
        await bounded.a.check(read(alice, D1), fresh());
        expect(outer(bounded.cache)?.tags).to.include('subject:user:bob');
        expect(outer(bounded.cache)?.tags).to.deep.equal(outer(plain.cache)?.tags);
      });

      it('B14: a nested expiry that cannot be read keeps every decision above out of the caches', () => {
        const nested = newNested();
        nestExpiry(nested, new Date(NaN));
        expect(nested.uncacheable).to.equal(true);
        expect(nested.until).to.equal(undefined);
        nestExpiry(nested, new Date(T0 + 9_000));
        nestExpiry(nested, expiry);
        nestExpiry(nested, undefined);
        expect(nested.until?.getTime()).to.equal(expiry.getTime());
      });
    });

    describe('a decision resting on a nested answer the model memoised in ctx.cache ends with that answer', () => {
      const carol = principal('user', 'carol');
      const T0 = fakeClock().now.getTime();
      const expiry = new Date(T0 + 5_000);
      type Grants = Readonly<Record<string, { readonly until: Date; readonly effect?: 'deny'; readonly after?: Promise<void> }>>;
      /** Each grantee may write until its grant ends (or, for 'deny', is refused until then); alice may read when every grantee `asks` names may write, and memoises each settled answer under the grantee's id. */
      const memoising = (clock: FakeClock, grants: Grants, asks: (req: DecisionRequest) => readonly Principal[], checks: string[]) => {
        const answerOf = async (ctx: EvaluationContext, grantee: Principal): Promise<boolean> => {
          const hit = ctx.cache.get(grantee.id);
          if (typeof hit === 'boolean') return hit;
          checks.push(grantee.id);
          const allowed = (await ctx.check({ principal: grantee, permission: 'doc:write', resource: D1, env: {} })).allowed;
          ctx.cache.set(grantee.id, allowed);
          return allowed;
        };
        const vote = async (req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> => {
          const grant = grants[req.principal.id];
          if (grant) {
            if (grant.after) await grant.after;
            const live = clock.now.getTime() < grant.until.getTime();
            if (grant.effect === 'deny') return live ? pass('m', FALSE, { denyWhen: TRUE, validUntil: grant.until }) : pass('m', TRUE);
            return live ? pass('m', TRUE, { validUntil: grant.until }) : pass('m', FALSE);
          }
          const answers = await Promise.all(asks(req).map((p) => answerOf(ctx, p)));
          return pass('m', answers.every((x) => x) ? TRUE : FALSE);
        };
        return { vote, answerOf };
      };
      const built = (grants: Grants, asks: (req: DecisionRequest) => readonly Principal[] = () => [bob]) => {
        const clock = fakeClock();
        const cache = new RecordingCache({ clock: clock.clock });
        const checks: string[] = [];
        const { vote } = memoising(clock, grants, asks, checks);
        const a = new Authorizer({ domain: 'root', registry, models: [new StaticModel('m', { vote })], adapters: [new FakeAdapter(['doc', 'folder'], { rows: rows() })], clock: clock.clock, cache });
        return { a, cache, clock, checks };
      };
      const stored = (cache: RecordingCache, on: ResourceRef) => cache.sets.filter((s) => s.decision.principal.id === 'alice' && s.decision.resource.id === on.id).at(-1);

      it('B14: a memoised nested allow bounds the decision that reads it and is not served after the grant ended (review SX36-RV-F2)', async () => {
        const { a, cache, clock, checks } = built({ bob: { until: expiry } });
        const scope = fresh();
        expect((await a.check(read(alice, D1), scope)).allowed).to.equal(true);
        clock.advance(1_000);
        const d2 = await a.check(read(alice, D2), scope);
        expect(d2.allowed).to.equal(true);
        // Inside its bound the memo still saves the nested check.
        expect(checks).to.deep.equal(['bob']);
        expect(d2.validUntil?.getTime()).to.equal(expiry.getTime());
        expect(stored(cache, D2)?.ttlMs).to.equal(4_000);
        expect(stored(cache, D2)?.tags).to.include('subject:user:bob');
        clock.advance(5_000);
        expect((await a.check(read(alice, D2), scope)).allowed).to.equal(false);
        expect(checks).to.deep.equal(['bob', 'bob']);
        expect((await a.check(read(alice, D2), fresh())).allowed).to.equal(false);
      });

      it('B14: a memoised nested deny that ends is asked again after its cause ended', async () => {
        const { a, cache, clock, checks } = built({ bob: { until: expiry, effect: 'deny' } });
        const scope = fresh();
        expect((await a.check(read(alice, D1), scope)).allowed).to.equal(false);
        expect((await a.check(read(alice, D2), scope)).allowed).to.equal(false);
        expect(checks).to.deep.equal(['bob']);
        expect(stored(cache, D2)?.ttlMs).to.equal(5_000);
        clock.advance(6_000);
        expect((await a.check(read(alice, D2), scope)).allowed).to.equal(true);
        expect(checks).to.deep.equal(['bob', 'bob']);
      });

      it('B14: of two memoised nested answers the earlier bound wins', async () => {
        const asks = (req: DecisionRequest) => (req.resource.id === 'd1' ? [bob] : req.resource.id === 'd2' ? [carol] : [bob, carol]);
        const { a, cache, checks } = built({ bob: { until: expiry }, carol: { until: new Date(T0 + 3_000) } }, asks);
        const scope = fresh();
        await a.check(read(alice, D1), scope);
        await a.check(read(alice, D2), scope);
        const both = await a.check({ principal: alice, permission: 'folder:read', resource: F1 }, scope);
        expect(both.allowed).to.equal(true);
        expect(checks).to.deep.equal(['bob', 'carol']);
        expect(both.validUntil?.getTime()).to.equal(T0 + 3_000);
        expect(stored(cache, F1)?.ttlMs).to.equal(3_000);
        expect(stored(cache, F1)?.tags).to.include.members(['subject:user:bob', 'subject:user:carol']);
      });

      it('B14: two overlapping decisions that found no settled answer each check for themselves and are both bounded', async () => {
        const { a, cache, checks } = built({ bob: { until: expiry } });
        const scope = fresh();
        const [d1, d2] = await Promise.all([a.check(read(alice, D1), scope), a.check(read(alice, D2), scope)]);
        expect(checks).to.deep.equal(['bob', 'bob']);
        expect([d1.validUntil?.getTime(), d2.validUntil?.getTime()]).to.deep.equal([expiry.getTime(), expiry.getTime()]);
        expect([stored(cache, D1)?.ttlMs, stored(cache, D2)?.ttlMs]).to.deep.equal([5_000, 5_000]);
      });

      it('B14: a decision that read a settled answer while its writer still ran another nested check rests on that check too', async () => {
        let openCarol!: () => void;
        let openDave!: () => void;
        const dave = principal('user', 'dave');
        const asks = (req: DecisionRequest) => (req.resource.id === 'd1' ? [bob, carol] : [bob, dave]);
        const { a, cache, checks } = built(
          {
            bob: { until: expiry },
            carol: { until: new Date(T0 + 3_000), after: new Promise<void>((resolve) => (openCarol = resolve)) },
            dave: { until: new Date(T0 + 10_000), after: new Promise<void>((resolve) => (openDave = resolve)) },
          },
          asks,
        );
        const scope = fresh();
        const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
        const first = a.check(read(alice, D1), scope);
        await turn();
        // The second decision reads bob's answer while the first still waits on carol, and ends after the first.
        const second = a.check(read(alice, D2), scope);
        await turn();
        openCarol();
        await first;
        openDave();
        const d2 = await second;
        expect(checks).to.deep.equal(['bob', 'carol', 'dave']);
        expect(d2.validUntil?.getTime()).to.equal(T0 + 3_000);
        expect(stored(cache, D2)?.ttlMs).to.equal(3_000);
        expect(stored(cache, D2)?.tags).to.include('subject:user:carol');
      });

      it('B14: a nested answer a preload memoised bounds the decisions that read it', async () => {
        const clock = fakeClock();
        const cache = new RecordingCache({ clock: clock.clock });
        const checks: string[] = [];
        const { vote, answerOf } = memoising(clock, { bob: { until: expiry } }, () => [bob], checks);
        class Preloading extends StaticModel {
          async preload(p: Principal, ctx?: EvaluationContext): Promise<void> {
            if (ctx && p.id === alice.id) await answerOf(ctx, bob);
          }
        }
        const a = new Authorizer({ domain: 'root', registry, models: [new Preloading('m', { vote })], adapters: [new FakeAdapter(['doc', 'folder'], { rows: rows() })], clock: clock.clock, cache });
        const scope = fresh();
        await a.preload(alice, scope);
        const d1 = await a.check(read(alice, D1), scope);
        expect(checks).to.deep.equal(['bob']);
        expect(d1.validUntil?.getTime()).to.equal(expiry.getTime());
        expect(stored(cache, D1)?.ttlMs).to.equal(5_000);
      });

      it('B14: the memo lives in the request scope: another request asks again', async () => {
        const { a, checks } = built({ bob: { until: expiry } });
        await a.check(read(alice, D1), fresh());
        await a.check(read(alice, D2), fresh());
        expect(checks).to.deep.equal(['bob', 'bob']);
      });

      it('B14: a memoised value that no nested check produced shortens nothing, and ctx.cache keeps the Map surface', async () => {
        let loads = 0;
        const surface: unknown[] = [];
        const m = new StaticModel('m', {
          vote: async (_req: DecisionRequest, ctx: EvaluationContext) => {
            if (!ctx.cache.has('load')) {
              loads++;
              ctx.cache.set('load', Promise.resolve(1)).set('other', 2);
            }
            ctx.cache.delete('other');
            surface.push(ctx.cache.size, [...ctx.cache.keys()], [...ctx.cache.values()].length, [...ctx.cache].length, [...ctx.cache.entries()].length);
            ctx.cache.forEach((_v, k, map) => surface.push(k, map === ctx.cache));
            // A Map member the memo view does not override would read the view's own empty storage.
            const own = Reflect.ownKeys(Reflect.getPrototypeOf(ctx.cache) ?? {});
            surface.push(Reflect.ownKeys(Map.prototype).every((k) => k === Symbol.toStringTag || own.includes(k)));
            return pass('m', TRUE);
          },
        });
        const { a, cache } = setup([m]);
        const scope = fresh();
        await a.check(read(alice, D1), scope);
        const d2 = await a.check(read(alice, D2), scope);
        expect(loads).to.equal(1);
        expect(d2.validUntil).to.equal(undefined);
        expect(cache.sets.map((s) => s.ttlMs)).to.deep.equal([60_000, 60_000]);
        expect(surface.slice(0, 8)).to.deep.equal([1, ['load'], 1, 1, 1, 'load', true, true]);
      });
    });

    it('B14: a decision resting on a nested decision served from the L2 stays out of the L2, as the nested tags are unknown (review P2)', async () => {
      const m = new StaticModel('m', {
        vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'bob') return pass('m', TRUE);
          return pass('m', (await ctx.check({ principal: bob, permission: 'doc:read', resource: req.resource, env: {} })).allowed ? TRUE : FALSE);
        },
      });
      const { a, cache } = setup([m]);
      const aliceCalls = () => m.calls.filter((c) => c.req.principal.id === 'alice').length;
      await a.check(read(bob, D1), fresh());
      const scope = fresh();
      expect((await a.check(read(alice, D1), scope)).allowed).to.equal(true);
      expect(cache.sets.map((s) => s.decision.principal.id)).to.deep.equal(['bob']);
      // It still answers again inside its request.
      await a.check(read(alice, D1), scope);
      expect(aliceCalls()).to.equal(1);
      await a.check(read(alice, D1), fresh());
      expect(aliceCalls()).to.equal(2);
    });

    it('B14: a decision whose intersect delegate is served from the L2 stays out of the L2', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a, cache } = setup([m]);
      await a.check(read(bob, D1), fresh());
      const token = principal('token', 't1', { onBehalfOf: bob, delegation: 'intersect' });
      expect((await a.check(read(token, D1), fresh())).allowed).to.equal(true);
      await a.check(read(token, D1), fresh());
      expect(cache.sets.map((s) => s.decision.principal.id)).to.deep.equal(['bob']);
      expect(m.calls.map((c) => c.req.principal.id)).to.deep.equal(['bob', 't1', 't1']);
    });

    it('B14: a grandchild principal invalidated drops the decision that rests on a nested L2 hit (review P2)', async () => {
      const db = { bobOk: true };
      const m = new StaticModel('m', {
        vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'bob') return pass('m', db.bobOk ? TRUE : FALSE);
          const asks = req.permission === 'doc:write' ? { principal: bob, permission: 'doc:write' } : { principal: alice, permission: 'doc:write' };
          return pass('m', (await ctx.check({ ...asks, resource: req.resource, env: {} })).allowed ? TRUE : FALSE);
        },
      });
      const { a } = setup([m]);
      const write: CheckInput = { principal: alice, permission: 'doc:write', resource: D1 };
      expect((await a.check(write, fresh())).allowed).to.equal(true);
      expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(true);
      db.bobOk = false;
      a.invalidate(['subject:user:bob']);
      expect((await a.check(write, fresh())).allowed).to.equal(false);
      expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(false);
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

  describe('request scope generation and review fixes (wiring step 10 review)', () => {
    /** Like RBAC: the principal's grant is read once per request into ctx.cache. */
    class PerRequest extends StaticModel {
      constructor(private readonly db: { granted: boolean }) {
        super('m', {
          vote: (_req: DecisionRequest, ctx: EvaluationContext) => {
            if (!ctx.cache.has('granted')) ctx.cache.set('granted', db.granted);
            return pass('m', ctx.cache.get('granted') === true ? TRUE : FALSE);
          },
        });
      }

      version(): string {
        return this.db.granted ? 'v1' : 'v2';
      }

      async preload(_p: Principal, ctx?: EvaluationContext): Promise<void> {
        ctx?.cache.set('granted', this.db.granted);
      }
    }

    it('B14: request-scoped data read before an invalidate never reaches the L2 through a later check of that request (review P1)', async () => {
      const db = { granted: true };
      const m = new PerRequest(db);
      // Keep the version fixed: only invalidate() tells the engine.
      m.version = () => 'v1';
      const { a, cache } = setup([m]);
      const scope = fresh();
      expect((await a.check(read(alice, D1), scope)).allowed).to.equal(true);
      db.granted = false;
      a.invalidate(['subject:user:alice']);
      // The request keeps what it read; that answer stays in the request.
      await a.check(read(alice, D2), scope);
      expect(cache.sets.map((s) => s.decision.resource.id)).to.deep.equal(['d1']);
      expect((await a.check(read(alice, D2), fresh())).allowed).to.equal(false);
    });

    it('B14: data a preload put in the request scope before an invalidate never reaches the L2', async () => {
      const db = { granted: true };
      const m = new PerRequest(db);
      m.version = () => 'v1';
      const { a, cache } = setup([m]);
      const scope = fresh();
      await a.preload(alice, scope);
      db.granted = false;
      a.invalidate(['subject:user:alice']);
      await a.check(read(alice, D1), scope);
      expect(cache.sets).to.have.length(0);
      expect((await a.check(read(alice, D1), fresh())).allowed).to.equal(false);
    });

    it('B14: request-scoped data read before a version change never reaches the L2', async () => {
      const db = { granted: true };
      const { a, cache } = setup([new PerRequest(db)]);
      const scope = fresh();
      expect((await a.check(read(alice, D1), scope)).allowed).to.equal(true);
      // The model's version moves with its data; no invalidate() call.
      db.granted = false;
      await a.check(read(alice, D2), scope);
      expect(cache.sets.map((s) => s.decision.resource.id)).to.deep.equal(['d1']);
      expect((await a.check(read(alice, D2), fresh())).allowed).to.equal(false);
    });

    it('B14: a request scope that spans an Authorizer rebuild after an invalidate stores nothing in the new L2 (re-review R1)', async () => {
      const db = { granted: true };
      const build = () => {
        const m = new PerRequest(db);
        m.version = () => 'v1';
        return setup([m]);
      };
      const { a: a1 } = build();
      const scope = fresh();
      expect((await a1.check(read(alice, D1), scope)).allowed).to.equal(true);
      db.granted = false;
      a1.invalidate(['subject:user:alice']);
      // Decision 20: the host rebuilds the domain with a fresh cache; the request goes on with the new instance.
      const { a: a2, cache: cache2 } = build();
      await a2.check(read(alice, D2), scope);
      expect(cache2.sets).to.have.length(0);
      expect((await a2.check(read(alice, D2), fresh())).allowed).to.equal(false);
    });

    it('B14: a rebuilt Authorizer never serves the old instance L1 decisions of a shared request scope (re-review R1)', async () => {
      const m2 = new StaticModel('m', { vote: deny() });
      const scope = fresh();
      expect((await setup([new StaticModel('m', { vote: permit() })]).a.check(read(alice, D1), scope)).allowed).to.equal(true);
      expect((await setup([m2]).a.check(read(alice, D1), scope)).allowed).to.equal(false);
      expect(m2.calls).to.have.length(1);
    });

    it('B14: explain() evaluates an intersect delegate live, never from the caches (review P3)', async () => {
      const db = { bobOk: true };
      const m = new StaticModel('m', { vote: (req: DecisionRequest) => pass('m', req.principal.id !== 'bob' || db.bobOk ? TRUE : FALSE) });
      const { a, cache } = setup([m]);
      await a.check(read(bob, D1), fresh());
      const bobCalls = () => m.calls.filter((c) => c.req.principal.id === 'bob').length;
      const gets = cache.gets.length;
      db.bobOk = false;
      const agent = principal('token', 't1', { onBehalfOf: bob, delegation: 'intersect' });
      const d = await a.explain(read(agent, D1), fresh());
      expect(bobCalls()).to.equal(2);
      expect(d.allowed).to.equal(false);
      expect(cache.gets).to.have.length(gets);
      expect(cache.sets).to.have.length(1);
    });

    it('B14: explain() runs a nested ctx.check live too', async () => {
      const m = new StaticModel('m', {
        vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'bob') return pass('m', TRUE);
          return pass('m', (await ctx.check({ principal: bob, permission: 'doc:read', resource: req.resource, env: {} })).allowed ? TRUE : FALSE);
        },
      });
      const { a, cache } = setup([m]);
      await a.check(read(bob, D1), fresh());
      const gets = cache.gets.length;
      await a.explain(read(alice, D1), fresh());
      expect(m.calls.map((c) => c.req.principal.id)).to.deep.equal(['bob', 'alice', 'bob']);
      expect(cache.gets).to.have.length(gets);
    });

    it('B14: the key is the delegation the check resolved, even when onBehalfOf changes while a step waits (review M4)', async () => {
      const carol = principal('user', 'carol');
      const m = new StaticModel('m', { vote: (req: DecisionRequest) => pass('m', req.principal.id === 'carol' ? FALSE : TRUE) });
      const token = principal('token', 't1', { onBehalfOf: bob, delegation: 'intersect' });
      let swap = true;
      class Swapping extends FakeAdapter {
        ancestors(r: ResourceRef): Promise<readonly ResourceRef[] | null> {
          if (swap) {
            swap = false;
            (token as { onBehalfOf?: Principal }).onBehalfOf = carol;
          }
          return super.ancestors(r);
        }
      }
      const clock = fakeClock();
      const cache = new RecordingCache({ clock: clock.clock });
      const a = new Authorizer({ domain: 'root', registry, models: [m], adapters: [new Swapping(['doc', 'folder'], { rows: rows() })], clock: clock.clock, cache });
      expect((await a.check(read(token, D1), fresh())).allowed).to.equal(true);
      const viaCarol = principal('token', 't1', { onBehalfOf: carol, delegation: 'intersect' });
      expect((await a.check(read(viaCarol, D1), fresh())).allowed).to.equal(false);
    });

    it('B14: after a failed cache invalidate the L2 is not used until a full invalidation succeeds (review M5)', async () => {
      let down = false;
      class Flaky extends RecordingCache {
        invalidate(tags: readonly string[]): void {
          if (down) throw new Error('cache down');
          super.invalidate(tags);
        }
      }
      const m = new StaticModel('m', { vote: permit() });
      const clock = fakeClock();
      const log = new RecordingLog();
      const cache = new Flaky({ clock: clock.clock });
      const a = new Authorizer({ domain: 'root', registry, models: [m], clock: clock.clock, log, cache });
      await a.check(read(), fresh());
      down = true;
      a.invalidate(['subject:user:alice']);
      expect(log.at('error').filter((e) => /decision cache failed to invalidate/.test(e.message))).to.have.length(1);
      const gets = cache.gets.length;
      await a.check(read(), fresh());
      await a.check(read(), fresh());
      // The stale allow is still in the cache; it is never read, and nothing new is stored.
      expect(m.calls).to.have.length(3);
      expect(cache.gets).to.have.length(gets);
      expect(cache.sets).to.have.length(1);
      down = false;
      // The engine retries invalidate(['*']) at the next call; once it succeeds, the L2 is back.
      await a.check(read(), fresh());
      expect(cache.invalidations.at(-1)).to.deep.equal(['*']);
      expect(m.calls).to.have.length(4);
      expect(cache.sets).to.have.length(2);
      await a.check(read(), fresh());
      expect(m.calls).to.have.length(4);
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

    it("B14: an intersect delegate's denial, never audited as bob's, is audited once when a direct check of bob reuses it", async () => {
      const m = new StaticModel('m', { vote: (req: DecisionRequest) => (req.principal.id === 't1' ? pass('m', TRUE) : pass('m', FALSE)) });
      const { a, audit } = setup([m], { l2: false });
      const scope = fresh();
      await a.check(read(principal('token', 't1', { onBehalfOf: bob })), scope);
      expect(audit.entries.map((e) => [e.principal.id, e.reason])).to.deep.equal([['t1', 'delegate']]);
      await a.check(read(bob), scope);
      await a.check(read(bob), scope);
      expect(m.calls).to.have.length(2);
      expect(audit.entries.map((e) => [e.principal.id, e.reason])).to.deep.equal([
        ['t1', 'delegate'],
        ['bob', 'no_access'],
      ]);
    });
  });

  describe('fresh checks', () => {
    it('a fresh check skips the L2, runs the models and stores its answer', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a, cache } = setup([m]);
      await a.check(read(alice, D1), fresh());
      await a.check(read(alice, D1, { fresh: true }), fresh());
      expect(m.calls).to.have.length(2);
      expect(cache.sets).to.have.length(2);
      await a.check(read(alice, D1), fresh());
      expect(m.calls).to.have.length(2);
    });

    it('a fresh check skips the L1 of its own request', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a } = setup([m], { l2: false });
      const scope = fresh();
      await a.check(read(alice, D1), scope);
      await a.check(read(alice, D1, { fresh: true }), scope);
      expect(m.calls).to.have.length(2);
    });

    it('a permission declared consistency fresh never reads a cache', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const strict = registryOf([{ name: 'doc:read', types: ['doc'], consistency: 'fresh' }, { name: 'doc:write', types: ['doc'] }, { name: 'folder:read', types: ['folder'] }]);
      const { a } = setup([m], { registry: strict });
      await a.check(read(alice, D1), fresh());
      await a.check(read(alice, D1), fresh());
      expect(m.calls).to.have.length(2);
    });

    it('models see fresh on the request only for fresh checks', async () => {
      const m = new StaticModel('m', { vote: permit() });
      const { a } = setup([m], { l2: false });
      await a.check(read(alice, D1), fresh());
      await a.check(read(alice, D1, { fresh: true }), fresh());
      expect(m.calls[0].req.fresh).to.equal(undefined);
      expect(m.calls[1].req.fresh).to.equal(true);
    });

    it("a fresh check's nested ctx.check is fresh too and reads no L2", async () => {
      const m = new StaticModel('m', {
        vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
          if (req.principal.id === 'bob') return pass('m', TRUE);
          const theirs = await ctx.check({ principal: bob, permission: 'doc:read', resource: req.resource, env: {} });
          return pass('m', theirs.allowed ? TRUE : FALSE);
        },
      });
      const { a } = setup([m]);
      await a.check(read(alice, D1), fresh());
      const inner = () => m.calls.filter((c) => c.req.principal.id === 'bob');
      expect(inner()).to.have.length(1);
      await a.check(read(alice, D1, { fresh: true }), fresh());
      expect(inner()).to.have.length(2);
      expect(inner()[1].req.fresh).to.equal(true);
      expect(inner()[0].req.fresh).to.equal(undefined);
    });

    it('refuses a fresh that is not a boolean', async () => {
      const { a } = setup([new StaticModel('m', { vote: permit() })]);
      let error: unknown;
      try {
        await a.check(read(alice, D1, { fresh: 'yes' as never }), fresh());
      } catch (e) {
        error = e;
      }
      expect(String(error)).to.match(/fresh must be a boolean/);
    });
  });
});
