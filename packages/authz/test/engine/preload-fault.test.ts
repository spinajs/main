import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { MAX_CHECK_DEPTH, ModelContext, l1Key } from '../../src/engine/context.js';
import { FALSE, GLOBAL, TRUE } from '../../src/index.js';
import type { DecisionRequest, EvaluationContext, ModelSummary, Principal, ResourceRef, Vote } from '../../src/index.js';
import { FakeScopeResolver, RecordingAudit, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'doc:write', types: ['doc'] },
  { name: 'doc:delete', types: ['doc'] },
]);
const alice = principal('user', 'alice');
const bob = principal('user', 'bob');
const carol = principal('user', 'carol');
const d1: ResourceRef = { type: 'doc', id: 'd1' };
const grants: Record<string, string[]> = { alice: ['doc:read', 'doc:delete'], bob: ['doc:read'] };
const bobWrite = (req: DecisionRequest) => req.principal.id === 'bob' && req.permission === 'doc:write';

class Resolver extends FakeScopeResolver {
  constructor(private readonly down: boolean) {
    super(['doc'], { 'doc:d1': null });
  }
  ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    return this.down ? Promise.reject(new Error('resolver down')) : super.ancestors(ref);
  }
}

// bob holds doc:write when d1 is known; the model fills its memo in preload and swallows host failures.
class Preloading extends StaticModel {
  constructor(private readonly via: 'ancestors' | 'check' | 'throw') {
    super('rbac', {
      vote: ((req: DecisionRequest, ctx: EvaluationContext) => {
        if (req.principal.id === 'carol') return { model: 'rbac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        if (!bobWrite(req)) return { model: 'rbac', permitWhen: grants[req.principal.id]?.includes(req.permission) ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
        return { model: 'rbac', permitWhen: ctx.cache.get('d1') === true ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
      }) as never,
    });
  }
  async preload(p: Principal, ctx?: EvaluationContext): Promise<void> {
    if (p.id !== 'bob' || !ctx) return;
    if (this.via === 'throw') throw new Error('store down');
    const known =
      this.via === 'ancestors'
        ? ctx.ancestors(d1).then(
            (a) => a !== null,
            () => false,
          )
        : ctx.check({ principal: carol, permission: 'doc:read', resource: d1 }).then(
            () => true,
            () => false,
          );
    ctx.cache.set('d1', await known);
  }
}

const make = (via: 'ancestors' | 'check' | 'throw', down: boolean) => new Authorizer({ domain: 'root', models: [new Preloading(via)], registry: REG, clock: fakeClock().clock, log: new RecordingLog(), audit: new RecordingAudit(), scopeResolvers: [new Resolver(down)] } as never);

describe('Authorizer: faults memoised during preload', () => {
  for (const via of ['ancestors', 'check'] as const) {
    it(`a ${via} rejection that preload memoised makes covers in the same request false`, async () => {
      const failing = make(via, true);
      const scope = new Map<string, unknown>();
      await failing.preload(bob, { cache: scope });
      expect((await failing.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache: scope })).allowed).to.equal(false);
      expect(await failing.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);

      const working = make(via, false);
      const control = new Map<string, unknown>();
      await working.preload(bob, { cache: control });
      expect((await working.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache: control })).allowed).to.equal(true);
      expect(await working.covers(alice, bob, GLOBAL, { cache: control })).to.equal(false);
    });
  }

  it('a summarize that leaves a partial memo and throws makes covers in the same request false', async () => {
    // bob's doc:write reads a memo that summarize fills; a failing summarize leaves it "known: false".
    class Summarizing extends StaticModel {
      constructor(private readonly fails: boolean) {
        super('rbac', {
          vote: ((req: DecisionRequest, ctx: EvaluationContext) => {
            if (!bobWrite(req)) return { model: 'rbac', permitWhen: grants[req.principal.id]?.includes(req.permission) ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
            return { model: 'rbac', permitWhen: ctx.cache.get('d1') !== false ? TRUE : FALSE, denyWhen: FALSE, cacheable: true } as Vote;
          }) as never,
        });
      }
      async summarize(p: Principal, _at: ResourceRef, ctx: EvaluationContext): Promise<ModelSummary> {
        if (p.id === 'bob') ctx.cache.set('d1', false);
        if (this.fails && p.id === 'bob') throw new Error('store down');
        if (p.id === 'bob') ctx.cache.delete('d1');
        return { model: 'rbac', permissions: [] };
      }
    }
    const build = (fails: boolean) => new Authorizer({ domain: 'root', models: [new Summarizing(fails)], registry: REG, clock: fakeClock().clock, log: new RecordingLog(), audit: new RecordingAudit() } as never);

    const failing = build(true);
    const scope = new Map<string, unknown>();
    await failing.summary(bob, GLOBAL, { cache: scope });
    expect(await failing.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);

    const healthy = build(false);
    const control = new Map<string, unknown>();
    await healthy.summary(bob, GLOBAL, { cache: control });
    // bob holds doc:write, which alice lacks; with a shared memo the failing case would read bob as read-only and say true.
    expect(await healthy.covers(alice, bob, GLOBAL, { cache: control })).to.equal(false);
  });

  it('a nested check refused at the depth limit marks the request scope at once', async () => {
    const host = { domain: 'root', permissions: REG, conditions: undefined, ancestors: () => null, attributes: () => Promise.resolve(null), relation: () => undefined, nestedCheck: () => Promise.reject(new Error('not reached')) } as never;
    const scope = new Map<string, unknown>();
    const ctx = new ModelContext(host, 'rbac', scope, new Date(0), MAX_CHECK_DEPTH, undefined);
    await ctx.check({ principal: carol, permission: 'doc:read', resource: d1 }).catch(() => undefined);
    expect(scope.get(l1Key('fault', 'root', ''))).to.equal(true);
    expect(ctx.fault).to.be.a('string');
  });

  it('a preload that throws makes covers in the same request false', async () => {
    const failing = make('throw', false);
    const scope = new Map<string, unknown>();
    await failing.preload(bob, { cache: scope });
    expect(await failing.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);

    const fresh = make('throw', false);
    expect(await fresh.covers(alice, bob, GLOBAL, { cache: new Map() })).to.equal(true);
  });
});
