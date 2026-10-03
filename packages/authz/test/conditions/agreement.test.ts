import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { Authorizer } from '../../src/engine/authorizer.js';
import { LruDecisionCache } from '../../src/engine/cache.js';
import { defaultAttribute, evaluateResidual } from '../../src/engine/evaluate.js';
import { AuthorizationModel, CONDITION_UNKNOWN, CORE_FILTER_OPS, ConditionFunction, DefaultConditionCompiler, FALSE, GLOBAL, TRUE, not } from '../../src/index.js';
import type { Condition, Decision, DecisionRequest, EvaluationContext, ModelCapabilities, PermissionDef, Principal, ResourceFilter, ResourceRef, Vote } from '../../src/index.js';
import { FakeAdapter, FakeRow, FakeScopeResolver, fakeClock, principal, registryOf } from '../engine/fakes.js';
import { FAULT, oracle } from './oracle.js';
import type { OracleWorld, Outcome } from './oracle.js';
import { FIELDS, condition } from './arbitraries.js';

const expect = chai.expect;

// Test doubles for the generator's function names; the built-ins are task 3's.
class TestFn extends ConditionFunction {
  constructor(readonly name: string, private readonly impl: (args: Record<string, unknown>, env: Readonly<Record<string, unknown>>) => boolean) {
    super();
  }
  evaluate(args: unknown, ctx: { env: Readonly<Record<string, unknown>> }): boolean {
    return this.impl(args as Record<string, unknown>, ctx.env);
  }
}
const FUNCTIONS = [new TestFn('glob', (a) => typeof a.value === 'string' && typeof a.pattern === 'string' && a.value.startsWith(a.pattern.replace(/[*%_\\].*$/, ''))), new TestFn('time.between', (_a, env) => env.flag === true), new TestFn('ip.in', () => false), new TestFn('wildcard', () => true)];
const FUNCTION_MAP = new Map(FUNCTIONS.map((f) => [f.name, f as ConditionFunction]));

type Form = 'permit' | 'deny';

/**
 * Votes the compiled condition as its permit (or deny) residual; a deny vote permits everything
 * else. Without a subject, a condition that needs one permits nothing or denies everything, as
 * design §6.2 has the ABAC model do (fail closed).
 */
class ConditionModel extends AuthorizationModel {
  readonly name = 'cond';
  readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'never', fields: false, needsSubject: true };
  needsSubject = false;
  constructor(private readonly condition: Condition, private readonly form: Form) {
    super();
  }
  init(): void {}
  applies(_def: PermissionDef): boolean {
    return true;
  }
  async evaluate(req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> {
    const out = await ctx.conditions.compile(this.condition, req, ctx);
    const blind = out.needsSubject && req.subject === undefined;
    if (blind) this.needsSubject = true;
    return this.form === 'permit' ? { model: 'cond', permitWhen: blind ? FALSE : out.filter, denyWhen: FALSE, cacheable: out.cacheable } : { model: 'cond', permitWhen: TRUE, denyWhen: blind ? TRUE : out.filter, cacheable: out.cacheable };
  }
}

const REG = registryOf([{ name: 'file:read', types: ['file', 'branch'] }]);
const clock = fakeClock();

const scalar = fc.constantFrom<unknown>('a', 'b', 'open', 'release/1', 'x/y', '1', '2', 1, 2, 0, true, false, null, new Date('2026-01-01T00:00:00.000Z'));
const maybe = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(a, { nil: undefined, freq: 3 });
const record = (keys: readonly string[], value: fc.Arbitrary<unknown> = scalar) => fc.record(Object.fromEntries(keys.map((k) => [k, maybe(value)])) as Record<string, fc.Arbitrary<unknown>>).map(dropUndefined);
function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

interface Node {
  readonly id: string;
  readonly org: string | undefined;
  readonly attrs: Readonly<Record<string, unknown>>;
}

interface WorldSpec {
  readonly principal: Principal;
  /** Checks run as this agent (inherit), so the models see `principal` as the principal and the agent as the actor. */
  readonly agent?: Principal;
  readonly env: Readonly<Record<string, unknown>>;
  /** A second request env, asked after the first with the same L2 cache. */
  readonly env2: Readonly<Record<string, unknown>>;
  readonly orgs: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
  readonly global: Readonly<Record<string, unknown>>;
  /** Adapter rows (type file). */
  readonly rows: readonly Node[];
  /** Scope-resolver nodes (type branch) whose attributes are the resource's own. */
  readonly branches: readonly Node[];
}

const nodes = (prefix: string) => fc.array(fc.record({ org: fc.constantFrom<string | undefined>('o1', 'o2', undefined), attrs: record(FIELDS) }), { minLength: 1, maxLength: 3 }).map((xs) => xs.map((r, i) => ({ ...r, id: `${prefix}${i}` })));

const world: fc.Arbitrary<WorldSpec> = fc
  .record({
    principal: fc.record({ id: fc.constantFrom('alice', 'a', '1'), attributes: record(['pool', 'n', 'team']) }).map((p) => principal('user', p.id, { attributes: p.attributes })),
    agentAttributes: fc.option(record(['team']), { nil: undefined, freq: 2 }),
    env: record(['region', 'n', 'flag'], fc.oneof(scalar, fc.boolean())),
    env2: record(['region', 'n', 'flag'], fc.oneof(scalar, fc.boolean())),
    orgs: fc.record({ o1: fc.oneof(fc.constant({}), fc.record({ policies: record(['level', 'open']) })), o2: fc.constantFrom<Record<string, unknown> | null>({}, { policies: { level: 'b', open: false } }) }),
    global: fc.record({ flags: record(['on']) }),
    rows: nodes('f'),
    branches: nodes('b'),
  })
  .map(({ agentAttributes, ...w }) => (agentAttributes === undefined ? w : { ...w, agent: principal('agent', 'ag1', { attributes: agentAttributes, onBehalfOf: w.principal, delegation: 'inherit' }) }));

const orgRef = (org: string | undefined): ResourceRef | undefined => (org ? { type: 'org', id: org } : undefined);

function setup(spec: WorldSpec) {
  const rows = spec.rows.map((r) => new FakeRow('file', r.id, r.attrs, orgRef(r.org)));
  const scopeAttributes: Record<string, Readonly<Record<string, unknown>> | null> = { 'org:o1': spec.orgs.o1, 'org:o2': spec.orgs.o2 };
  const adapter = new FakeAdapter(['file', 'org'], { rows, nodes: { 'org:o1': null, 'org:o2': null }, scopeAttributes });
  const branchResolver = new FakeScopeResolver(['branch'], Object.fromEntries(spec.branches.map((b) => [`branch:${b.id}`, orgRef(b.org) ?? null])), Object.fromEntries(spec.branches.map((b) => [`branch:${b.id}`, b.attrs])));
  const compiler = new DefaultConditionCompiler(FUNCTIONS, [branchResolver], [adapter]);
  const make = (c: Condition, form: Form) => {
    const model = new ConditionModel(c, form);
    const authorizer = new Authorizer({
      domain: 'root',
      models: [model],
      registry: REG,
      adapters: [adapter],
      scopeResolvers: [branchResolver],
      conditions: compiler,
      cache: new LruDecisionCache({ maxEntries: 100, clock: clock.clock }),
      scopeAttributes: { schemas: [{ scopeType: '$global', schema: {}, defaults: spec.global }] },
      clock: clock.clock,
    });
    return { model, authorizer };
  };
  const oracleWorld = (type: 'file' | 'branch', node: Node, env: Readonly<Record<string, unknown>>): OracleWorld => {
    const ref: ResourceRef = { type, id: node.id };
    const parent = orgRef(node.org);
    return {
      principal: spec.principal,
      ...(spec.agent ? { actor: spec.agent } : {}),
      env: { ...env, now: clock.clock() },
      ref,
      ancestors: parent ? [ref, parent, GLOBAL] : [ref, GLOBAL],
      attributes: (n) => (n.type === '$global' ? spec.global : n.type === 'org' ? scopeAttributes[`org:${n.id}`] ?? {} : {}),
      row: type === 'file' ? (rows.find((r) => r.id === node.id) as unknown as Record<string, unknown>) : node.attrs,
      functions: FUNCTION_MAP,
    };
  };
  return { rows, make, oracleWorld };
}

const expected = (o: Outcome, form: Form): boolean => (form === 'permit' ? o === true : o === false);
const show = (o: Outcome): string => (o === FAULT ? 'FAULT' : String(o));

/** What a decision without a subject lets through for one row: its residual, evaluated as SQL would. */
async function selects(d: Decision, row: unknown, w: OracleWorld): Promise<boolean> {
  if (!d.allowed) return false;
  const env = { principal: w.principal, ref: w.ref, attribute: defaultAttribute, relation: () => undefined, ancestors: async () => w.ancestors, native: () => undefined, ctx: undefined as never };
  return (await evaluateResidual(d.residual, row, env)) === true;
}

describe('conditions: compiled residual agrees with the direct Kleene evaluation', function () {
  // Hundreds of Authorizer checks per property.
  this.timeout(120_000);

  it('row by row through the engine: with the subject, by id alone, and from a warm L2 under another env; permit and deny', async () => {
    await fc.assert(
      fc.asyncProperty(condition(), world, async (c, spec) => {
        const { rows, make, oracleWorld } = setup(spec);
        const as = spec.agent ?? spec.principal;
        for (const form of ['permit', 'deny'] as const) {
          const { model, authorizer } = make(c, form);
          for (const row of rows) {
            const ref = { type: 'file', id: row.id };
            const node = spec.rows.find((r) => r.id === row.id)!;
            const w1 = oracleWorld('file', node, spec.env);
            const want1 = await oracle(c, w1);
            const withSubject = await authorizer.check({ principal: as, permission: 'file:read', resource: ref, subject: row, env: spec.env });
            expect(withSubject.allowed, `${form} ${row.id} with subject: oracle ${show(want1)}, reason ${withSubject.reason?.code}`).to.equal(expected(want1, form));

            model.needsSubject = false;
            const byId = await authorizer.check({ principal: as, permission: 'file:read', resource: ref, env: spec.env });
            const got = await selects(byId, row, w1);
            const at = `${form} ${row.id} by id: oracle ${show(want1)}, residual ${JSON.stringify(byId.residual)}`;
            if (model.needsSubject) expect(!got || expected(want1, form), `needs the subject, but grants: ${at}`).to.equal(true);
            else expect(got, at).to.equal(expected(want1, form));

            const want2 = await oracle(c, oracleWorld('file', node, spec.env2));
            const again = await authorizer.check({ principal: as, permission: 'file:read', resource: ref, subject: row, env: spec.env2 });
            expect(again.allowed, `${form} ${row.id} env2: oracle ${show(want2)}`).to.equal(expected(want2, form));
          }
        }
      }),
      { numRuns: 500, seed: 3201 },
    );
  });

  it('a type-level residual selects, row by row in the engine evaluator (the SQL reference), what the direct evaluation allows; never more when it needs the subject', async () => {
    await fc.assert(
      fc.asyncProperty(condition(), world, async (c, spec) => {
        const { rows, make, oracleWorld } = setup(spec);
        for (const form of ['permit', 'deny'] as const) {
          const { model, authorizer } = make(c, form);
          const decision = await authorizer.check({ principal: spec.agent ?? spec.principal, permission: 'file:read', resource: { type: 'file' }, env: spec.env });
          for (const row of rows) {
            const w = oracleWorld('file', spec.rows.find((r) => r.id === row.id)!, spec.env);
            const want = expected(await oracle(c, w), form);
            const got = await selects(decision, row, w);
            const at = `${form} ${row.id}: residual ${JSON.stringify(decision.residual)}`;
            if (model.needsSubject) expect(!got || want, `needs subject, but grants: ${at}`).to.equal(true);
            else expect(got, at).to.equal(want);
          }
        }
      }),
      { numRuns: 500, seed: 3202 },
    );
  });

  it('a resource with a scope resolver and no adapter is decided by id alone from its attributes', async () => {
    await fc.assert(
      fc.asyncProperty(condition(), world, async (c, spec) => {
        const { make, oracleWorld } = setup(spec);
        for (const form of ['permit', 'deny'] as const) {
          const { model, authorizer } = make(c, form);
          for (const b of spec.branches) {
            const w = oracleWorld('branch', b, spec.env);
            const want = await oracle(c, w);
            model.needsSubject = false;
            const d = await authorizer.check({ principal: spec.agent ?? spec.principal, permission: 'file:read', resource: { type: 'branch', id: b.id }, env: spec.env });
            const got = await selects(d, b.attrs, w);
            const at = `${form} ${b.id}: oracle ${show(want)}, residual ${JSON.stringify(d.residual)}`;
            if (model.needsSubject) expect(!got || expected(want, form), `needs the subject, but grants: ${at}`).to.equal(true);
            else expect(got, at).to.equal(expected(want, form));
          }
        }
      }),
      { numRuns: 300, seed: 3203 },
    );
  });

  describe('CONDITION_UNKNOWN never grants', () => {
    const alice = principal('user', 'alice');
    const row = new FakeRow('file', 'f0', {});
    const model = (name: string, vote: Partial<Vote>): AuthorizationModel =>
      new (class extends AuthorizationModel {
        readonly name = name;
        readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'always', fields: false, needsSubject: false };
        init(): void {}
        applies(): boolean {
          return true;
        }
        evaluate(): Vote {
          return { model: name, permitWhen: FALSE, denyWhen: FALSE, cacheable: true, ...vote };
        }
      })();
    const grants = async (votes: readonly Partial<Vote>[], algorithm: string): Promise<boolean> => {
      const a = new Authorizer({ domain: 'root', models: votes.map((v, i) => model(`m${i}`, v)), registry: REG, combine: { default: { algorithm } }, clock: clock.clock });
      const typeLevel = await a.check({ principal: alice, permission: 'file:read', resource: { type: 'file' } });
      const withRow = await a.check({ principal: alice, permission: 'file:read', resource: { type: 'file', id: 'f0' }, subject: row });
      expect(typeLevel.residual.op === 'true' || typeLevel.residual.op === 'false', JSON.stringify(typeLevel.residual)).to.equal(true);
      return typeLevel.residual.op === 'true' || withRow.allowed;
    };
    const U: ResourceFilter = CONDITION_UNKNOWN;

    for (const algorithm of ['deny-overrides', 'permit-overrides', 'first-applicable']) {
      it(`one model, ${algorithm}: not as a permit, under not, as a deny or as a negated deny`, async () => {
        expect(await grants([{ permitWhen: U }], algorithm)).to.equal(false);
        expect(await grants([{ permitWhen: not(U) }], algorithm)).to.equal(false);
        expect(await grants([{ permitWhen: TRUE, denyWhen: U }], algorithm)).to.equal(false);
        expect(await grants([{ permitWhen: TRUE, denyWhen: not(U) }], algorithm)).to.equal(false);
        expect(await grants([{ permitWhen: TRUE }], algorithm)).to.equal(true);
      });
    }

    it('first-applicable: an UNKNOWN model before a permitting one decides nothing either way', async () => {
      // OR(U, TRUE ∧ ¬U) is UNKNOWN in Kleene logic: neither model applies for sure.
      expect(await grants([{ permitWhen: U }, { permitWhen: TRUE }], 'first-applicable')).to.equal(false);
      expect(await grants([{ denyWhen: U }, { permitWhen: TRUE }], 'first-applicable')).to.equal(false);
      expect(await grants([{ permitWhen: FALSE }, { permitWhen: TRUE }], 'first-applicable')).to.equal(true);
    });
  });
});
