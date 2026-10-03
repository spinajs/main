import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { Authorizer } from '../../src/engine/authorizer.js';
import { defaultAttribute, evaluateResidual } from '../../src/engine/evaluate.js';
import { AuthorizationModel, CONDITION_UNKNOWN, CORE_FILTER_OPS, ConditionFunction, DefaultConditionCompiler, FALSE, GLOBAL, TRUE, not } from '../../src/index.js';
import type { Condition, DecisionRequest, EvaluationContext, ModelCapabilities, PermissionDef, Principal, ResourceFilter, ResourceRef, Vote } from '../../src/index.js';
import { FakeAdapter, FakeRow, fakeClock, principal, registryOf } from '../engine/fakes.js';
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

/** Votes the compiled condition as its permit (or deny) residual; a deny vote permits everything else. */
class ConditionModel extends AuthorizationModel {
  readonly name = 'cond';
  readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'never', fields: false, needsSubject: true };
  constructor(private readonly condition: Condition, private readonly form: Form) {
    super();
  }
  init(): void {}
  applies(_def: PermissionDef): boolean {
    return true;
  }
  async evaluate(req: DecisionRequest, ctx: EvaluationContext): Promise<Vote> {
    const { filter, cacheable } = await ctx.conditions.compile(this.condition, req, ctx);
    return this.form === 'permit' ? { model: 'cond', permitWhen: filter, denyWhen: FALSE, cacheable } : { model: 'cond', permitWhen: TRUE, denyWhen: filter, cacheable };
  }
}

const REG = registryOf([{ name: 'file:read', types: ['file'] }]);
const clock = fakeClock();
const compiler = new DefaultConditionCompiler(FUNCTIONS);

const scalar = fc.constantFrom<unknown>('a', 'b', 'open', 'release/1', 'x/y', '1', '2', 1, 2, 0, true, false, null, new Date('2026-01-01T00:00:00.000Z'));
const maybe = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> => fc.option(a, { nil: undefined, freq: 3 });
const record = (keys: readonly string[], value: fc.Arbitrary<unknown> = scalar) => fc.record(Object.fromEntries(keys.map((k) => [k, maybe(value)])) as Record<string, fc.Arbitrary<unknown>>).map(dropUndefined);
function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

interface WorldSpec {
  readonly principal: Principal;
  readonly env: Readonly<Record<string, unknown>>;
  readonly orgs: Readonly<Record<string, Readonly<Record<string, unknown>> | null>>;
  readonly global: Readonly<Record<string, unknown>>;
  readonly rows: readonly { readonly id: string; readonly org: string | undefined; readonly attrs: Readonly<Record<string, unknown>> }[];
}

const world: fc.Arbitrary<WorldSpec> = fc.record({
  principal: fc.record({ id: fc.constantFrom('alice', 'a', '1'), attributes: record(['pool', 'n', 'team']) }).map((p) => principal('user', p.id, { attributes: p.attributes })),
  env: record(['region', 'n', 'flag'], fc.oneof(scalar, fc.boolean())),
  orgs: fc.record({ o1: fc.oneof(fc.constant({}), fc.record({ policies: record(['level', 'open']) })), o2: fc.constantFrom<Record<string, unknown> | null>({}, { policies: { level: 'b', open: false } }) }),
  global: fc.record({ flags: record(['on']) }),
  rows: fc.array(fc.record({ org: fc.constantFrom<string | undefined>('o1', 'o2', undefined), attrs: record(FIELDS) }), { minLength: 1, maxLength: 3 }).map((rows) => rows.map((r, i) => ({ ...r, id: `f${i}` }))),
});

function setup(spec: WorldSpec) {
  const rows = spec.rows.map((r) => new FakeRow('file', r.id, r.attrs, r.org ? { type: 'org', id: r.org } : undefined));
  const scopeAttributes: Record<string, Readonly<Record<string, unknown>> | null> = { 'org:o1': spec.orgs.o1, 'org:o2': spec.orgs.o2 };
  const adapter = new FakeAdapter(['file', 'org'], { rows, nodes: { 'org:o1': null, 'org:o2': null }, scopeAttributes });
  const make = (c: Condition, form: Form) =>
    new Authorizer({
      domain: 'root',
      models: [new ConditionModel(c, form)],
      registry: REG,
      adapters: [adapter],
      conditions: compiler,
      scopeAttributes: { schemas: [{ scopeType: '$global', schema: {}, defaults: spec.global }] },
      clock: clock.clock,
    });
  const oracleWorld = (row: FakeRow): OracleWorld => {
    const ref: ResourceRef = { type: 'file', id: row.id };
    const ancestors = row.$parent ? [ref, row.$parent, GLOBAL] : [ref, GLOBAL];
    return {
      principal: spec.principal,
      env: { ...spec.env, now: clock.clock() },
      ref,
      ancestors,
      attributes: (node) => (node.type === '$global' ? spec.global : node.type === 'org' ? scopeAttributes[`org:${node.id}`] ?? {} : {}),
      row: row as unknown as Record<string, unknown>,
      functions: FUNCTION_MAP,
    };
  };
  return { rows, make, oracleWorld };
}

const expected = (o: Outcome, form: Form): boolean => (form === 'permit' ? o === true : o === false);
const show = (o: Outcome): string => (o === FAULT ? 'FAULT' : String(o));

describe('conditions: compiled residual agrees with the direct Kleene evaluation', () => {
  it('row by row through the engine, as a permit and as a deny (three-valued)', async () => {
    await fc.assert(
      fc.asyncProperty(condition(), world, async (c, spec) => {
        const { rows, make, oracleWorld } = setup(spec);
        for (const form of ['permit', 'deny'] as const) {
          const authorizer = make(c, form);
          for (const row of rows) {
            const want = await oracle(c, oracleWorld(row));
            const got = await authorizer.check({ principal: spec.principal, permission: 'file:read', resource: { type: 'file', id: row.id }, subject: row, env: spec.env });
            expect(got.allowed, `${form} row ${row.id}: oracle ${show(want)}, reason ${got.reason?.code}`).to.equal(expected(want, form));
          }
        }
      }),
      { numRuns: 500, seed: 3201 },
    );
  });

  it('a type-level residual selects, row by row in the engine evaluator (the SQL reference), what the direct evaluation allows', async () => {
    await fc.assert(
      fc.asyncProperty(condition({ roots: ['principal', 'resource', 'env'], functions: false }), world, async (c, spec) => {
        const { rows, make, oracleWorld } = setup(spec);
        for (const form of ['permit', 'deny'] as const) {
          const decision = await make(c, form).check({ principal: spec.principal, permission: 'file:read', resource: { type: 'file' }, env: spec.env });
          for (const row of rows) {
            const want = expected(await oracle(c, oracleWorld(row)), form);
            const ow = oracleWorld(row);
            const env = { principal: spec.principal, ref: ow.ref, attribute: defaultAttribute, relation: () => undefined, ancestors: async () => ow.ancestors, native: () => undefined, ctx: undefined as never };
            const got = decision.allowed && (await evaluateResidual(decision.residual, row, env)) === true;
            expect(got, `${form} row ${row.id}: residual ${JSON.stringify(decision.residual)}`).to.equal(want);
          }
        }
      }),
      { numRuns: 500, seed: 3202 },
    );
  });

  it('CONDITION_UNKNOWN never grants: not under not, not as a negated deny, not under first-applicable', async () => {
    const spec: WorldSpec = { principal: principal('user', 'alice'), env: {}, orgs: { o1: {}, o2: {} }, global: {}, rows: [{ id: 'f0', org: undefined, attrs: {} }] };
    const { rows } = setup(spec);
    const run = async (vote: Partial<Vote>, algorithm = 'deny-overrides'): Promise<boolean> => {
      class M extends AuthorizationModel {
        readonly name = 'm';
        readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'always', fields: false, needsSubject: false };
        init(): void {}
        applies(): boolean {
          return true;
        }
        evaluate(): Vote {
          return { model: 'm', permitWhen: FALSE, denyWhen: FALSE, cacheable: true, ...vote };
        }
      }
      const a = new Authorizer({ domain: 'root', models: [new M()], registry: REG, combine: { default: { algorithm } }, clock: clock.clock });
      const typeLevel = await a.check({ principal: spec.principal, permission: 'file:read', resource: { type: 'file' } });
      const row = await a.check({ principal: spec.principal, permission: 'file:read', resource: { type: 'file', id: 'f0' }, subject: rows[0] });
      expect(typeLevel.residual.op === 'true' || typeLevel.residual.op === 'false', JSON.stringify(typeLevel.residual)).to.equal(true);
      return typeLevel.residual.op === 'true' || row.allowed;
    };
    const U: ResourceFilter = CONDITION_UNKNOWN;
    for (const algorithm of ['deny-overrides', 'permit-overrides', 'first-applicable']) {
      expect(await run({ permitWhen: U }, algorithm)).to.equal(false);
      expect(await run({ permitWhen: not(U) }, algorithm)).to.equal(false);
      expect(await run({ permitWhen: TRUE, denyWhen: U }, algorithm)).to.equal(false);
      expect(await run({ permitWhen: TRUE, denyWhen: not(U) }, algorithm)).to.equal(false);
    }
    expect(await run({ permitWhen: TRUE })).to.equal(true);
  });
});
