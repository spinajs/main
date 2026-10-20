import { AssertionError, strict as assert } from 'node:assert';
import 'mocha';

import { AuthorizationModel, CORE_FILTER_OPS, FALSE, GLOBAL, TRUE } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, FilterOp, ModelCapabilities, Principal, ResourceFilter, ResourceRef, Vote } from '@spinajs/authz';

import { FakeAdapter, FakeRbacModel, FakeRelationResolver, StaticModel, adapterConformanceChecks, modelConformanceChecks, servicePrincipal, userPrincipal, worldRows } from '../../src/index.js';
import type { AdapterCheckId, AdapterFactory, ConformanceCheck, FakeAssignment, ModelCheckId, ModelFactory, ModelSetup } from '../../src/index.js';
import { b19Factory, plainAdapterSetup, rbacAdapter, rbacFactory, rbacRoles, rbacSeeds, staticFactory, staticRows, tupleFactory } from './worlds.js';

// Type-level only, never called: a factory with a seed type needs `seeds`.
export function seedsAreRequired(): void {
  // @ts-expect-error seeds missing for ModelFactory<TupleGraph>
  modelConformanceChecks(tupleFactory);
  // @ts-expect-error seeds missing for ModelFactory<TupleGraph>
  modelConformanceChecks(tupleFactory, { numRuns: 1 });
}

const FAST = { numRuns: 15 };

const one = <Id extends string>(checks: readonly ConformanceCheck<Id>[], id: Id): ConformanceCheck<Id> => checks.find((c) => c.id === id)!;

const fails = (c: ConformanceCheck, message: RegExp): Promise<void> =>
  assert.rejects(c.run(), (e: unknown) => {
    assert.ok(e instanceof AssertionError, `expected an AssertionError, got ${String(e)}`);
    assert.match(e.message, message);
    return true;
  });

const modelCheck = (factory: ModelFactory, id: ModelCheckId) => one(modelConformanceChecks(factory, FAST), id);

/** A world of files with a status column, read by one user and refused to another. */
function world(model: AuthorizationModel): ModelSetup {
  const adapter = new FakeAdapter({
    types: ['file'],
    rows: {
      file: [
        { id: 'a', status: 'open' },
        { id: 'b', status: 'closed' },
        { id: 'c', status: 'open' },
      ],
    },
  });
  return { model, world: { principals: [userPrincipal('alice'), userPrincipal('nobody')], permissions: ['file:read'], rows: worldRows(adapter), context: { adapters: [adapter], permissions: ['file:read'] } } };
}

const open: ResourceFilter = { op: 'cmp', field: 'status', cmp: 'eq', value: 'open' };
const p1: ResourceRef = { type: 'project', id: 'p1' };
const forAlice = (req: DecisionRequest, f: ResourceFilter): ResourceFilter => (req.principal.id === 'alice' ? f : FALSE);

/** The pieces every hand-written model below shares; each overrides what it gets wrong. */
abstract class Base extends AuthorizationModel {
  readonly name: string = 'broken';
  readonly capabilities: ModelCapabilities = { effects: ['permit'], residuals: CORE_FILTER_OPS, sync: 'always', fields: false, needsSubject: false };
  init(): void {}
  applies(): boolean {
    return true;
  }
  protected vote(permitWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote {
    return { model: this.name, permitWhen, denyWhen: FALSE, cacheable: true, ...extra };
  }
}

describe('conformance: the suites catch dishonest implementations', () => {
  it('a model that emits an op it does not declare fails "votes"', async () => {
    const undeclared = () => world(new StaticModel({ capabilities: { residuals: ['true', 'false', 'and', 'or', 'not'] }, votes: (req) => ({ permitWhen: forAlice(req, open) }) }));
    await fails(modelCheck(undeclared, 'votes'), /uses op 'cmp', which capabilities\.residuals does not declare/);
  });

  it('a permit-only model that denies fails "votes"', async () => {
    const denier = () => world(new StaticModel({ capabilities: { effects: ['permit'] }, votes: (req) => ({ permitWhen: forAlice(req, TRUE), denyWhen: open }) }));
    await fails(modelCheck(denier, 'votes'), /effects has no 'deny', but the vote denies/);
  });

  it('a model that claims sync: always and answers with a promise fails "sync"; with sync: never it passes', async () => {
    const lying = () => world(new StaticModel({ votes: async (req) => ({ permitWhen: forAlice(req, open) }) }));
    await fails(modelCheck(lying, 'sync'), /sync is 'always', but evaluate returned a promise/);
    const honest = () => world(new StaticModel({ capabilities: { sync: 'never' }, votes: async (req) => ({ permitWhen: forAlice(req, open) }) }));
    await modelCheck(honest, 'sync').run();
  });

  it('a model whose sync: after-preload claim ignores its own preload fails "sync"', async () => {
    class SlowAfterPreload extends Base {
      readonly capabilities: ModelCapabilities = { ...new StaticModel().capabilities, sync: 'after-preload' };
      async preload(): Promise<void> {}
      async evaluate(req: DecisionRequest): Promise<Vote> {
        return this.vote(forAlice(req, open));
      }
    }
    await fails(
      modelCheck(() => world(new SlowAfterPreload()), 'sync'),
      /sync is 'after-preload', but evaluate returned a promise after preload/,
    );
  });

  it('a type-level residual that disagrees with the concrete vote fails "agreement"', async () => {
    class Disagrees extends Base {
      evaluate(req: DecisionRequest): Vote {
        if (req.resource.id == null) return this.vote(forAlice(req, TRUE));
        return this.vote(forAlice(req, req.resource.id === 'b' ? FALSE : TRUE));
      }
    }
    await fails(
      modelCheck(() => world(new Disagrees()), 'agreement'),
      /type-level vs concrete/,
    );
  });

  it('a concrete vote that reads the subject differently from its residual fails "agreement"', async () => {
    const twoFaced = () => world(new StaticModel({ votes: (req) => ({ permitWhen: forAlice(req, req.subject === undefined ? open : TRUE) }) }));
    await fails(modelCheck(twoFaced, 'agreement'), /with subject/);
  });

  it('a needs_subject vote is a partial answer: one that fails closed passes, one that permits too much fails "agreement"', async () => {
    await modelCheck(b19Factory, 'agreement').run();
    // B19: without the subject the vote must not permit; this one permits everything to alice.
    const leaks = () => world(new StaticModel({ capabilities: { needsSubject: true }, votes: (req) => (req.subject === undefined ? { permitWhen: forAlice(req, TRUE), reason: { code: 'needs_subject' } } : { permitWhen: forAlice(req, (req.subject as { status: string }).status === 'open' ? TRUE : FALSE) }) }));
    for (const id of ['capabilities', 'init', 'votes', 'sync', 'determinism'] as const) await modelCheck(leaks, id).run();
    await fails(modelCheck(leaks, 'agreement'), /needs the subject and permits the row/);
  });

  it('a needs_subject vote that skips a deny the subject would trigger fails "agreement"', async () => {
    // With the subject alice may read every row and closed rows are denied; without it the deny is missing.
    const skipsDeny = () =>
      world(
        new StaticModel({
          capabilities: { needsSubject: true },
          votes: (req) => {
            const row = req.subject as { status: string } | undefined;
            if (!row) return { permitWhen: forAlice(req, open), reason: { code: 'needs_subject' } };
            return { permitWhen: forAlice(req, TRUE), denies: [{ when: row.status === 'closed' ? TRUE : FALSE, reason: { code: 'closed' } }] };
          },
        }),
      );
    for (const id of ['capabilities', 'init', 'votes', 'sync', 'determinism'] as const) await modelCheck(skipsDeny, id).run();
    await fails(modelCheck(skipsDeny, 'agreement'), /the more informed vote denies the row .*, the less informed one needs the subject and does not/);
  });

  it('a type-level residual that allows a row the concrete error vote cannot decide fails "agreement"', async () => {
    class ErrsWhenConcrete extends Base {
      evaluate(req: DecisionRequest): Vote {
        return req.resource.id == null ? this.vote(forAlice(req, TRUE)) : this.vote(FALSE, { error: 'store down' });
      }
    }
    await fails(
      modelCheck(() => world(new ErrsWhenConcrete()), 'agreement'),
      /the more informed vote is indeterminate \(error store down\), the less informed one allows the row/,
    );
  });

  it('indeterminate votes are forbidden by default, and a type-level answer that never allows is vacuous', async () => {
    class ErrsAtTypeLevel extends Base {
      evaluate(req: DecisionRequest): Vote {
        return req.resource.id == null ? this.vote(FALSE, { error: 'no list support' }) : this.vote(forAlice(req, TRUE));
      }
    }
    const factory = () => world(new ErrsAtTypeLevel());
    await fails(modelCheck(factory, 'votes'), /indeterminate vote \(no list support\) where the options forbid them/);
    await fails(one(modelConformanceChecks(factory, { ...FAST, indeterminate: 'allow' }), 'agreement'), /the type-level answers must allow some row and refuse another.*got 0 allowed/);
  });

  it('a preload that changes the answer fails "sync"; a preload that only caches it passes', async () => {
    const caps: ModelCapabilities = { ...new StaticModel().capabilities, sync: 'after-preload' };
    class PreloadWidens extends Base {
      readonly capabilities = caps;
      async preload(_p: Principal, ctx: EvaluationContext): Promise<void> {
        ctx.cache.set('preloaded', true);
      }
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
        return ctx.cache.get('preloaded') ? this.vote(TRUE) : Promise.resolve(this.vote(forAlice(req, open)));
      }
    }
    await fails(
      modelCheck(() => world(new PreloadWidens()), 'sync'),
      /after preload the type-level vote differs from the one without preload/,
    );

    class PreloadCaches extends Base {
      readonly capabilities = caps;
      async preload(principal: Principal, ctx: EvaluationContext): Promise<void> {
        ctx.cache.set('principal', principal.id);
      }
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
        const v = this.vote(forAlice(req, open));
        return ctx.cache.get('principal') === req.principal.id ? v : Promise.resolve(v);
      }
    }
    await modelCheck(() => world(new PreloadCaches()), 'sync').run();
  });

  it('a preload that widens only concrete answers fails "sync", whatever the sync claim', async () => {
    for (const sync of ['after-preload', 'always', 'never'] as const) {
      class PreloadWidensChecks extends Base {
        readonly capabilities: ModelCapabilities = { ...new StaticModel().capabilities, sync };
        async preload(_p: Principal, ctx: EvaluationContext): Promise<void> {
          ctx.cache.set('preloaded', true);
        }
        evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote {
          return this.vote(req.resource.id != null && ctx.cache.get('preloaded') ? TRUE : forAlice(req, open));
        }
      }
      const factory = () => world(new PreloadWidensChecks());
      for (const id of ['capabilities', 'init', 'votes', 'agreement', 'determinism'] as const) await modelCheck(factory, id).run();
      await fails(modelCheck(factory, 'sync'), /in a shared context after preload, before the type-level votes, the (concrete|with subject) vote differs from the one in a fresh context/);
    }
  });

  it('a vote memoised in ctx.cache without the resource id fails "sync", with and without a preload', async () => {
    const status: Record<string, string> = { a: 'open', b: 'closed', c: 'open' };
    class MemoPerPermission extends Base {
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote {
        const key = `${req.principal.id}|${req.permission}`;
        const hit = ctx.cache.get(key) as Vote | undefined;
        if (hit) return hit;
        const v = this.vote(forAlice(req, req.resource.id == null ? open : status[req.resource.id] === 'open' ? TRUE : FALSE));
        ctx.cache.set(key, v);
        return v;
      }
    }
    class MemoWithPreload extends MemoPerPermission {
      async preload(): Promise<void> {}
    }
    for (const [model, shared] of [
      [() => new MemoPerPermission(), 'in a shared context'],
      [() => new MemoWithPreload(), 'in a shared context after preload'],
    ] as const) {
      const factory = () => world(model());
      for (const id of ['capabilities', 'init', 'votes', 'agreement', 'determinism'] as const) await modelCheck(factory, id).run();
      await fails(modelCheck(factory, 'sync'), new RegExp(`${shared}, before the type-level votes, the (concrete|with subject) vote differs from the one in a fresh context`));
    }
  });

  it('a check that a cached type-level vote short-cuts fails "sync"', async () => {
    // Once the list was asked in this request, any non-empty residual lets every check through.
    class ListShortcut extends Base {
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote {
        const key = `${req.principal.id}|${req.permission}`;
        if (req.resource.id == null) {
          const v = this.vote(forAlice(req, open));
          ctx.cache.set(key, v);
          return v;
        }
        const listed = ctx.cache.get(key) as Vote | undefined;
        if (listed && listed.permitWhen !== FALSE) return this.vote(TRUE);
        return this.vote(forAlice(req, req.subject === undefined ? open : (req.subject as { status: string }).status === 'open' ? TRUE : FALSE));
      }
    }
    const factory = () => world(new ListShortcut());
    for (const id of ['capabilities', 'init', 'votes', 'agreement', 'determinism'] as const) await modelCheck(factory, id).run();
    await fails(modelCheck(factory, 'sync'), /in a shared context, after the type-level votes, the (concrete|with subject) vote differs from the one in a fresh context/);
  });

  it('a permit left UNKNOWN where the less informed vote abstains fails "agreement"', async () => {
    // Under first-applicable an UNKNOWN permit stops the later models; the type-level FALSE lets them in.
    const adapter = new FakeAdapter({
      types: ['file'],
      rows: {
        file: [
          { id: 'a', status: 'open' },
          { id: 'b', status: 'closed' },
          { id: 'n', status: null },
        ],
      },
    });
    const byId: ResourceFilter = { op: 'cmp', field: 'id', cmp: 'eq', value: 'a' };
    const unknownOnNull: ModelFactory = () => ({
      model: new StaticModel({ votes: (req) => ({ permitWhen: forAlice(req, req.subject === undefined ? byId : open) }) }),
      world: { principals: [userPrincipal('alice'), userPrincipal('nobody')], permissions: ['file:read'], rows: worldRows(adapter), context: { adapters: [adapter], permissions: ['file:read'] } },
    });
    await fails(modelCheck(unknownOnNull, 'agreement'), /the less informed vote abstains on the row .*, the more informed one leaves its permit UNKNOWN/);
  });

  it('an invalidate that widens the principals it does not name fails "invalidate"', async () => {
    class WidensOthers extends FakeRbacModel {
      private named: readonly string[] | undefined;
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
        if (this.named && !this.named.includes(`subject:${req.principal.type}:${req.principal.id}`)) return { model: this.name, permitWhen: TRUE, denyWhen: FALSE, cacheable: true };
        return super.evaluate(req, ctx);
      }
      invalidate(tags: readonly string[]): void {
        this.named = tags;
      }
    }
    const widens: ModelFactory = async (input) => {
      const honest = await rbacFactory({ seed: [], shuffle: input.shuffle });
      const model = new WidensOthers({ roles: rbacRoles, assignments: [{ subject: userPrincipal('carol'), role: 'editor' }] });
      const row = rbacAdapter().all('file')[0];
      return {
        ...honest,
        model,
        mutations: [
          {
            title: 'assign a newcomer viewer',
            request: { principal: userPrincipal('newcomer'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: row },
            after: true,
            apply: () => {
              model.assign({ subject: userPrincipal('newcomer'), role: 'viewer' });
            },
            tags: ['subject:user:newcomer'],
            freshness: 'invalidate',
          },
        ],
      };
    };
    for (const id of ['capabilities', 'init', 'votes', 'sync', 'agreement', 'determinism'] as const) await modelCheck(widens, id).run();
    await fails(modelCheck(widens, 'invalidate'), /after the change: .* gives permit true, deny false; a fresh setup with the change applied gives permit false, deny false/);
  });

  it('a type-level vote that stays stale while the concrete one is live fails "invalidate"', async () => {
    class StaleList extends FakeRbacModel {
      private readonly memo = new Map<string, Vote | Promise<Vote>>();
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
        if (req.resource.id != null) return super.evaluate(req, ctx);
        const key = `${req.principal.type}:${req.principal.id}|${req.permission}|${req.resource.type}`;
        if (!this.memo.has(key)) this.memo.set(key, super.evaluate(req, ctx));
        return this.memo.get(key)!;
      }
      invalidate(): void {}
    }
    const stale: ModelFactory = async (input) => {
      const honest = await rbacFactory({ seed: [], shuffle: input.shuffle });
      const model = new StaleList({ roles: rbacRoles, assignments: [{ subject: userPrincipal('carol'), role: 'editor' }] });
      const row = rbacAdapter().all('file')[0];
      return {
        ...honest,
        model,
        mutations: [
          {
            title: 'assign bob viewer',
            request: { principal: userPrincipal('bob'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: row },
            after: true,
            apply: () => {
              model.assign({ subject: userPrincipal('bob'), role: 'viewer' });
            },
            freshness: 'live',
          },
        ],
      };
    };
    await fails(modelCheck(stale, 'invalidate'), /after the change: the type-level residual disagrees with the probe: permit false, deny false vs permit true/);
  });

  it('a concrete answer that a preloaded context keeps stale fails "invalidate"', async () => {
    // Memoised per principal once preloaded, as a role cache would be; invalidate is a no-op.
    class StalePreload extends FakeRbacModel {
      private readonly memo = new Map<string, Vote | Promise<Vote>>();
      async preload(principal: Principal, ctx: EvaluationContext): Promise<void> {
        ctx.cache.set('preloaded', principal.id);
      }
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
        if (req.resource.id == null || ctx.cache.get('preloaded') !== req.principal.id) return super.evaluate(req, ctx);
        const key = `${req.principal.id}|${req.permission}|${req.resource.id}|${req.subject === undefined}`;
        if (!this.memo.has(key)) this.memo.set(key, super.evaluate(req, ctx));
        return this.memo.get(key)!;
      }
      invalidate(): void {}
    }
    const stale: ModelFactory = async (input) => {
      const honest = await rbacFactory({ seed: [], shuffle: input.shuffle });
      const model = new StalePreload({ roles: rbacRoles, assignments: [{ subject: userPrincipal('carol'), role: 'editor' }] });
      const row = rbacAdapter().all('file')[0];
      return {
        ...honest,
        model,
        mutations: [
          {
            title: 'assign bob viewer',
            request: { principal: userPrincipal('bob'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: row },
            after: true,
            apply: () => {
              model.assign({ subject: userPrincipal('bob'), role: 'viewer' });
            },
            freshness: 'live',
          },
        ],
      };
    };
    await modelCheck(stale, 'sync').run();
    await fails(modelCheck(stale, 'invalidate'), /still answers false after the change after preload/);
  });

  it('a vote memo kept in the model and keyed without the resource id fails "sync" and "determinism"', async () => {
    // Probe A1: the first request of a (principal, permission, type) stores the vote all later ones reuse.
    class MemoPerType extends FakeRbacModel {
      private readonly memo = new Map<string, Vote | Promise<Vote>>();
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
        const key = `${this.version()}|${req.principal.type}:${req.principal.id}|${req.permission}|${req.resource.type}`;
        if (!this.memo.has(key)) this.memo.set(key, super.evaluate(req, ctx));
        return this.memo.get(key)!;
      }
    }
    const memo: ModelFactory = () => {
      // alice may read a and b (under p1), not c and d (under p2).
      const model = new MemoPerType({ roles: rbacRoles, assignments: [{ subject: userPrincipal('alice'), role: 'viewer', scope: p1 }] });
      const adapter = rbacAdapter();
      const row = adapter.all('file')[0];
      return {
        model,
        world: { principals: [userPrincipal('alice'), userPrincipal('nobody')], permissions: ['file:read'], rows: worldRows(adapter), context: { adapters: [adapter], permissions: ['file:read'] } },
        mutations: [
          {
            title: 'assign a newcomer viewer at p1',
            request: { principal: userPrincipal('newcomer'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: row },
            after: true,
            apply: () => {
              model.assign({ subject: userPrincipal('newcomer'), role: 'viewer', scope: p1 });
            },
            freshness: 'live',
          },
          {
            title: 'revoke alice',
            request: { principal: userPrincipal('alice'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: row },
            after: false,
            apply: () => {
              model.revoke({ subject: userPrincipal('alice'), role: 'viewer', scope: p1 });
            },
            freshness: 'version',
          },
        ],
      };
    };
    for (const id of ['capabilities', 'init', 'votes', 'agreement', 'invalidate'] as const) await modelCheck(memo, id).run();
    await fails(modelCheck(memo, 'sync'), /in a second setup asked rows first, the (concrete|with subject) vote differs from the first setup's fresh one/);
    await fails(modelCheck(memo, 'determinism'), /in load order B, asked in reverse order/);
  });

  it('a mutation whose apply does nothing before init is blamed on apply, not on the model', async () => {
    // Probe B1: as when init reloads from a store and drops a change made in memory.
    class LateApply extends FakeRbacModel {
      private ready = false;
      init(): void {
        this.ready = true;
      }
      revoke(a: FakeAssignment): this {
        return this.ready ? super.revoke(a) : this;
      }
    }
    const late: ModelFactory = async (input) => {
      const honest = await rbacFactory({ seed: [], shuffle: input.shuffle });
      const model = new LateApply({ roles: rbacRoles, assignments: [{ subject: userPrincipal('carol'), role: 'editor' }] });
      const row = rbacAdapter().all('file')[0];
      return {
        ...honest,
        model,
        mutations: [
          {
            title: 'revoke the global editor',
            request: { principal: userPrincipal('carol'), permission: 'file:write', resource: { type: 'file', id: 'a' }, subject: row },
            after: false,
            apply: () => {
              model.revoke({ subject: userPrincipal('carol'), role: 'editor' });
            },
            freshness: 'live',
          },
        ],
      };
    };
    await fails(modelCheck(late, 'invalidate'), /mutation 'revoke the global editor': applied before init, the probe still answers true; apply must work on a model that is not initialised/);
  });

  it('a new version that routes another permission is compared by permission; a live routing change fails "invalidate"', async () => {
    const rerouted =
      (freshness: 'version' | 'live'): ModelFactory =>
      () => {
        let edit = false;
        const model = new StaticModel({ applies: (def) => edit || def.name === 'file:read', votes: (req) => ({ permitWhen: forAlice(req, open) }) });
        const s = world(model);
        // file:edit first, so it takes the route index file:read had before the change.
        const permissions = ['file:edit', 'file:read'];
        return {
          ...s,
          world: { ...s.world, permissions, context: { ...s.world.context, permissions } },
          mutations: [
            {
              title: 'route file:edit and open file:read to all',
              request: { principal: userPrincipal('nobody'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: s.world.rows[0].subject },
              after: true,
              apply: () => {
                edit = true;
                model.respond((req) => ({ permitWhen: req.permission === 'file:read' ? TRUE : forAlice(req, open) }));
                if (freshness === 'version') model.bump();
              },
              freshness,
            },
          ],
        };
      };
    for (const c of modelConformanceChecks(rerouted('version'), FAST)) await c.run();
    await fails(modelCheck(rerouted('live'), 'invalidate'), /file:edit on file is routed in a fresh setup with the change applied and not in the setup under test/);
  });

  it('the suite asks requests with an actor when the world gives some, and the oracle reads actor.*', async () => {
    const actors: string[] = [];
    const factory: ModelFactory = () => {
      const s = world(
        new StaticModel({
          votes: (req) => {
            if (req.actor) actors.push(req.actor.id);
            const actor = req.actor ?? req.principal;
            const row = req.subject as { id: string } | undefined;
            return { permitWhen: row ? (row.id === actor.id ? TRUE : FALSE) : { op: 'cmp', field: 'id', cmp: 'eq', value: { ref: 'actor.id' } } };
          },
        }),
      );
      return { ...s, world: { ...s.world, principals: [userPrincipal('a'), userPrincipal('b')], actors: [[userPrincipal('a'), servicePrincipal('b')]] } };
    };
    for (const id of ['votes', 'agreement', 'determinism'] as const) await modelCheck(factory, id).run();
    assert.ok(actors.includes('b'), 'no request carried the actor');
  });

  it('runs 25 samples by default and disposes every setup it builds', async () => {
    let built = 0;
    let disposed = 0;
    const counted: ModelFactory = (input) => {
      built++;
      return { ...(staticFactory(input) as ModelSetup), dispose: () => void disposed++ };
    };
    await one(modelConformanceChecks(counted), 'votes').run();
    assert.equal(built, 25);
    assert.equal(disposed, 25);
    for (const c of modelConformanceChecks(counted, FAST)) await c.run();
    assert.equal(disposed, built);
  });

  it('a native op without a registered NativeFilter fails "init" and "votes"', async () => {
    class MissingNative extends Base {
      readonly capabilities: ModelCapabilities = { ...new StaticModel().capabilities, residuals: [...CORE_FILTER_OPS, 'native:broken.check'] as FilterOp[] };
      evaluate(req: DecisionRequest): Vote {
        return this.vote(req.resource.id == null ? { op: 'native:broken.check', args: { who: req.principal.id } } : forAlice(req, TRUE));
      }
    }
    const factory = () => world(new MissingNative());
    await fails(modelCheck(factory, 'init'), /declares native:broken\.check, but no NativeFilter is registered/);
    await fails(modelCheck(factory, 'votes'), /no NativeFilter is registered for it/);
  });

  it('applies routing a type outside resourceTypes fails "capabilities"', async () => {
    const strayRoute = () => world(new StaticModel({ capabilities: { resourceTypes: ['doc'] }, votes: (req) => ({ permitWhen: forAlice(req, open) }) }));
    await fails(modelCheck(strayRoute, 'capabilities'), /outside resourceTypes/);
  });

  it('a cache that ignores invalidate fails "invalidate"; FakeRbacModel itself passes', async () => {
    class Stale extends FakeRbacModel {
      private readonly memo = new Map<string, Vote | Promise<Vote>>();
      evaluate(req: DecisionRequest, ctx: EvaluationContext): Vote | Promise<Vote> {
        const key = `${req.principal.type}:${req.principal.id}|${req.permission}|${req.resource.type}:${req.resource.id ?? ''}|${req.subject === undefined}`;
        if (!this.memo.has(key)) this.memo.set(key, super.evaluate(req, ctx));
        return this.memo.get(key)!;
      }
      invalidate(): void {}
    }
    const stale: ModelFactory = async (input) => {
      const honest = await rbacFactory({ seed: [], shuffle: input.shuffle });
      const model = new Stale({ roles: rbacRoles, assignments: [{ subject: userPrincipal('carol'), role: 'editor' }] });
      const adapter = rbacAdapter();
      const row = adapter.all('file')[0];
      return {
        ...honest,
        model,
        mutations: [
          {
            title: 'assign a newcomer viewer',
            request: { principal: userPrincipal('newcomer'), permission: 'file:read', resource: { type: 'file', id: 'a' }, subject: row },
            after: true,
            apply: () => {
              model.assign({ subject: userPrincipal('newcomer'), role: 'viewer' });
            },
            tags: ['subject:user:newcomer'],
            freshness: 'invalidate',
          },
        ],
      };
    };
    await fails(modelCheck(stale, 'invalidate'), /still answers false after the change/);
    await one(modelConformanceChecks(rbacFactory, { ...FAST, seeds: rbacSeeds }), 'invalidate').run();
  });

  it('a mutation that does not change the probe is refused rather than passed', async () => {
    const vacuous: ModelFactory = (input) => {
      const s = staticFactory(input) as ModelSetup;
      // alice may already read the open file a, so "permit all" changes nothing for this probe.
      return { ...s, mutations: [{ ...s.mutations![0], request: { ...s.mutations![0].request, principal: userPrincipal('alice'), resource: { type: 'file', id: 'a' }, subject: staticRows[0] } }] };
    };
    await fails(modelCheck(vacuous, 'invalidate'), /already answers true before the change/);
  });

  it('a deny reason that depends on load order fails "determinism"', async () => {
    const reasons = [
      { code: 'x', priority: 300, sortKey: 'a' },
      { code: 'y', priority: 300, sortKey: 'b' },
    ];
    // Reports only the first rule loaded, so the reported reason follows the load order.
    const firstWins: ModelFactory = ({ shuffle }) => {
      const [first] = shuffle(reasons);
      return world(new StaticModel({ votes: () => ({ denies: [{ when: TRUE, reason: first }] }) }));
    };
    await fails(modelCheck(firstWins, 'determinism'), /lowest \(priority, sortKey\) reason depends on load order/);
  });

  it('a vote that changes between two identical requests fails "determinism"', async () => {
    let n = 0;
    const flaky = () => world(new StaticModel({ votes: (req) => ({ permitWhen: forAlice(req, TRUE), validUntil: new Date(++n) }) }));
    await fails(modelCheck(flaky, 'determinism'), /the same request gave two different votes/);
  });

  describe('adapters', () => {
    const adapterCheck = (factory: AdapterFactory, id: AdapterCheckId) => one(adapterConformanceChecks(factory, FAST), id);

    it('ancestors that do not end in GLOBAL fail "refs"', async () => {
      class NoGlobal extends FakeAdapter {
        async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
          const chain = await super.ancestors(ref);
          return chain && chain.filter((r) => r.type !== GLOBAL.type);
        }
      }
      const factory: AdapterFactory = () => {
        const adapter = new NoGlobal({ types: ['file'], rows: { file: [{ id: 'a' }, { id: 'b' }] } });
        return { adapter, targets: adapter.all('file'), principals: [userPrincipal('alice')] };
      };
      await fails(adapterCheck(factory, 'refs'), /does not end in GLOBAL/);
    });

    it('ancestors that do not start with the ref itself fail "refs"', async () => {
      class Headless extends FakeAdapter {
        async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
          const chain = await super.ancestors(ref);
          return chain && chain.slice(1);
        }
      }
      const factory: AdapterFactory = () => {
        const adapter = new Headless({
          types: ['file'],
          rows: { file: [{ id: 'a' }] },
          parents: [
            [
              { type: 'file', id: 'a' },
              { type: 'project', id: 'p1' },
            ],
          ],
        });
        return { adapter, targets: adapter.all('file'), principals: [userPrincipal('alice')] };
      };
      await fails(adapterCheck(factory, 'refs'), /not the ref itself/);
    });

    it('a parent of a served type that ancestors calls unknown fails "refs"', async () => {
      const factory: AdapterFactory = () => {
        const adapter = new FakeAdapter({
          types: ['file', 'project'],
          rows: { file: [{ id: 'a' }], project: [] },
          parents: [
            [
              { type: 'file', id: 'a' },
              { type: 'project', id: 'p9' },
            ],
          ],
        });
        return { adapter, targets: adapter.all('file'), principals: [userPrincipal('alice')] };
      };
      await fails(adapterCheck(factory, 'refs'), /names .*p9.* as the parent, but ancestors of it is null/);
    });

    it('a query that drops `not` fails "compiles"', async () => {
      const strip = (f: ResourceFilter): ResourceFilter => (f.op === 'not' ? strip(f.arg) : f.op === 'and' || f.op === 'or' ? { op: f.op, args: f.args.map(strip) } : f);
      const leaky: AdapterFactory = () => {
        const s = plainAdapterSetup();
        return { ...s, query: (filter, q) => s.query!(strip(filter), q) };
      };
      await fails(adapterCheck(leaky, 'compiles'), /disagrees with the oracle/);
    });

    it('compiles claiming a native op without an in-memory evaluator fails "declarations"', async () => {
      const claims: AdapterFactory = () => {
        const adapter = new FakeAdapter({ types: ['file'], rows: { file: [{ id: 'a' }] }, compiles: [...CORE_FILTER_OPS, 'native:nowhere'] as FilterOp[] });
        return { adapter, targets: adapter.all('file'), principals: [userPrincipal('alice')] };
      };
      await fails(adapterCheck(claims, 'declarations'), /no NativeFilter to evaluate it in memory/);
    });

    it('a relation that answers differently without the subject fails "relations"', async () => {
      const factory: AdapterFactory = () => {
        const s = plainAdapterSetup();
        const adapter = new FakeAdapter({
          types: ['file'],
          rows: { file: [{ id: 'a', owner: 'alice' }] },
          relations: [new FakeRelationResolver('file', 'owner', (p, _ref, subject) => subject !== undefined && (subject as { owner: string }).owner === p.id)],
        });
        return { ...s, adapter, targets: adapter.all('file') };
      };
      await fails(adapterCheck(factory, 'relations'), /with the subject, false without it/);
    });
  });
});
