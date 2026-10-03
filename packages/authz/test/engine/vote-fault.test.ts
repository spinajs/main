import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import { CORE_FILTER_OPS, FALSE, GLOBAL, TRUE } from '../../src/index.js';
import type { DecisionRequest, EvaluationContext, ModelSummary, Principal, Vote } from '../../src/index.js';
import { FakeAdapter, FakeNativeFilter, FakeRow, RecordingAudit, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

const REG = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'doc:write', types: ['doc'] },
  { name: 'doc:delete', types: ['doc'] },
]);
const alice = principal('user', 'alice');
const bob = principal('user', 'bob');
const grants: Record<string, string[]> = { alice: ['doc:read', 'doc:delete'], bob: ['doc:read'] };
const bobWrite = (req: DecisionRequest) => req.principal.id === 'bob' && req.permission === 'doc:write';
const vote = (permit: boolean): Vote => ({ model: 'rbac', permitWhen: permit ? TRUE : FALSE, denyWhen: FALSE, cacheable: true });
const hang = () => new Promise((r) => setTimeout(r, 200));

type Mode = 'throw' | 'hang' | 'ok';

// bob holds doc:write when d1 is known. The vote trusts its memo when set; when empty it
// writes a placeholder, then asks its store. `loads` counts the store reads of bob's roles.
class SelfMemo extends StaticModel {
  loads = 0;
  constructor(mode: Mode) {
    super('rbac', {
      vote: (async (req: DecisionRequest, ctx: EvaluationContext) => {
        if (req.principal.id === 'bob' && !ctx.cache.has('roles')) {
          this.loads++;
          ctx.cache.set('roles', grants.bob);
        }
        if (!bobWrite(req)) return vote(grants[req.principal.id]?.includes(req.permission) === true);
        let known = ctx.cache.get('d1');
        if (known === undefined) {
          ctx.cache.set('d1', false);
          if (mode === 'throw') throw new Error('store down');
          if (mode === 'hang') await hang();
          known = true;
          ctx.cache.set('d1', known);
        }
        return vote(known === true);
      }) as never,
    });
  }
  // What the votes can give, so summary() keeps its candidates and covers sees no extra entry.
  summarize(p: Principal): Promise<ModelSummary> {
    const names = [...(grants[p.id] ?? []), ...(p.id === 'bob' ? ['doc:write'] : [])];
    return Promise.resolve({ model: 'rbac', permissions: names.map((name) => ({ name, conditional: false })) });
  }
}

const make = (model: StaticModel, options: Record<string, unknown> = {}) => new Authorizer({ domain: 'root', models: [model], registry: REG, clock: fakeClock().clock, log: new RecordingLog(), audit: new RecordingAudit(), config: { modelTimeoutMs: 50 }, ...options } as never);

describe('Authorizer: memos left by a faulted top-level decision', () => {
  for (const mode of ['throw', 'hang'] as const) {
    it(`a vote that writes ctx.cache then fails (${mode}) does not make covers in the same request true`, async () => {
      const failing = make(new SelfMemo(mode));
      const scope = new Map<string, unknown>();
      const d = await failing.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache: scope });
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('model_error');
      expect(await failing.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);

      const healthy = make(new SelfMemo('ok'));
      const control = new Map<string, unknown>();
      expect((await healthy.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache: control })).allowed).to.equal(true);
      // bob holds doc:write, which alice lacks; a vote reading the failed one's placeholder would say true.
      expect(await healthy.covers(alice, bob, GLOBAL, { cache: control })).to.equal(false);
    });
  }

  it('a summary whose own check faulted does not make covers in the same request true', async () => {
    const failing = make(new SelfMemo('throw'));
    const scope = new Map<string, unknown>();
    const s = await failing.summary(bob, GLOBAL, { cache: scope });
    expect(s.permissions.map((p) => p.name)).to.deep.equal(['doc:read']);
    expect(await failing.covers(alice, bob, GLOBAL, { cache: scope })).to.equal(false);
  });

  it('a top-level fault leaves later healthy checks their memo and keeps summaries whole', async () => {
    const model = new SelfMemo('throw');
    const a = make(model);
    const scope = new Map<string, unknown>();
    expect((await a.check({ principal: bob, permission: 'doc:read', resource: GLOBAL }, { cache: scope })).allowed).to.equal(true);
    expect((await a.check({ principal: bob, permission: 'doc:delete', resource: GLOBAL }, { cache: scope })).allowed).to.equal(false);
    expect(model.loads).to.equal(1);

    expect((await a.check({ principal: bob, permission: 'doc:write', resource: GLOBAL }, { cache: scope })).reason?.code).to.equal('model_error');
    // The faulted check's memo is dropped: the next vote loads again, then the memo serves the rest.
    expect((await a.check({ principal: bob, permission: 'doc:read', resource: { type: 'doc' } }, { cache: scope })).allowed).to.equal(true);
    expect(model.loads).to.equal(2);
    const s = await a.summary(bob, GLOBAL, { cache: scope });
    expect(s.permissions.map((p) => p.name)).to.deep.equal(['doc:read']);
    expect(model.loads).to.equal(2);
  });

  describe('a native filter evaluated with the core context', () => {
    // bob may read d1 unless the row is blocked. The filter trusts the core memo when set; when
    // empty it writes "not blocked" as a placeholder, then asks its store, which answers "blocked".
    const build = (mode: Mode) => {
      const row = new FakeRow('doc', 'd1');
      const blocked = new FakeNativeFilter('native:blocked', async (_args, _subject, _ref, ctx) => {
        if (ctx.cache.has('blocked')) return ctx.cache.get('blocked') === true;
        ctx.cache.set('blocked', false);
        if (mode === 'throw') throw new Error('store down');
        if (mode === 'hang') await hang();
        ctx.cache.set('blocked', true);
        return true;
      });
      const model = new StaticModel('rbac', { capabilities: { residuals: [...CORE_FILTER_OPS, 'native:blocked'] }, vote: { permitWhen: { op: 'not', arg: { op: 'native:blocked', args: {} } } } });
      return { row, a: make(model, { adapters: [new FakeAdapter(['doc'], { rows: [row] })], nativeFilters: [blocked] }) };
    };

    // A throw reads as UNKNOWN (residual_false), a timeout faults the subject step (model_error).
    for (const [mode, code] of [
      ['throw', 'residual_false'],
      ['hang', 'model_error'],
    ] as const) {
      it(`one that writes ctx.cache then fails (${mode}) does not allow a later check in the same request`, async () => {
        const { row, a } = build(mode);
        const scope = new Map<string, unknown>();
        const first = await a.check({ principal: bob, permission: 'doc:read', resource: row }, { cache: scope });
        expect(first.allowed).to.equal(false);
        expect(first.reason?.code).to.equal(code);
        expect((await a.check({ principal: bob, permission: 'doc:read', resource: row }, { cache: scope })).allowed).to.equal(false);

        const healthy = build('ok');
        const control = new Map<string, unknown>();
        expect((await healthy.a.check({ principal: bob, permission: 'doc:read', resource: healthy.row }, { cache: control })).allowed).to.equal(false);
        expect((await healthy.a.check({ principal: bob, permission: 'doc:read', resource: healthy.row }, { cache: control })).allowed).to.equal(false);
      });
    }
  });
});
