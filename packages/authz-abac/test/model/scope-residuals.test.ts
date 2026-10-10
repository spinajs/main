import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';
import { AuthorizationModel, Authorizer, AuthzConfigError, CORE_FILTER_OPS, DefaultConditionCompiler, FALSE, PermissionRegistryImpl, SCOPE_CONDITION_FILTER, SCOPE_CONDITION_OP, ScopeResolver, TRUE, and, defaultAttribute, evaluateResidual, not } from '@spinajs/authz';
import type { Condition, EvaluationContext, ModelCapabilities, Policy, Principal, ResourceFilter, ResourceRef, SubjectEnv, Vote } from '@spinajs/authz';
import { agentPrincipal, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AUTHZ_ABAC_CONFIGURATION_SCHEMA, AbacModel, ConfigPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice = userPrincipal('alice', { attributes: { pool: 'gold', teams: ['a', 'b'] } });

type Attrs = Readonly<Record<string, unknown>> | null;

/** A tree of scope nodes; a key mapped to null attributes is an unknown node, a missing key an unknown resource. */
class Tree extends ScopeResolver {
  readonly types = ['org', 'project', 'file'];
  constructor(private readonly parents: Readonly<Record<string, ResourceRef | null>>, private readonly attrs: Readonly<Record<string, Attrs>>) {
    super();
  }
  async ancestors(ref: ResourceRef): Promise<readonly ResourceRef[] | null> {
    if (!Object.hasOwn(this.parents, key(ref))) return null;
    const out: ResourceRef[] = [ref];
    for (let p = this.parents[key(ref)]; p && out.length < 16; p = this.parents[key(p)] ?? null) out.push(p);
    out.push({ type: '$global' });
    return out;
  }
  async attributes(ref: ResourceRef): Promise<Attrs> {
    return Object.hasOwn(this.attrs, key(ref)) ? this.attrs[key(ref)] : {};
  }
}
const key = (r: ResourceRef): string => `${r.type}:${r.id}`;

/** Permits the rows under `scopes` (nothing when empty). */
class UnderModel extends AuthorizationModel {
  readonly name = 'other';
  readonly capabilities: ModelCapabilities = { effects: ['permit', 'deny'], residuals: CORE_FILTER_OPS, sync: 'always', fields: false, needsSubject: false };
  constructor(private readonly scopes: readonly ResourceRef[]) {
    super();
  }
  init(): void {}
  applies(): boolean {
    return true;
  }
  evaluate(req: { resource: ResourceRef }, ctx: EvaluationContext): Vote | Promise<Vote> {
    if (this.scopes.length === 0) return { model: this.name, permitWhen: FALSE, denyWhen: FALSE, cacheable: true };
    if (req.resource.id === undefined) return { model: this.name, permitWhen: { op: 'under', scopes: this.scopes }, denyWhen: FALSE, cacheable: true };
    return ctx.ancestors(req.resource).then((list) => ({ model: this.name, permitWhen: (list ?? []).some((a) => this.scopes.some((s) => s.type === a.type && s.id === a.id)) ? { op: 'true' } : FALSE, denyWhen: FALSE, cacheable: true }));
  }
}

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'file:read', types: ['file'] }], 'test');
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['file:read'], source: 'test', ...extra });

const ALGORITHMS = ['deny-overrides', 'permit-overrides', 'first-applicable'] as const;

interface World {
  readonly tree: Tree;
  readonly rows: readonly { readonly ref: ResourceRef; readonly subject: Readonly<Record<string, unknown>> }[];
}

async function abacModel(policies: readonly Policy[], scopeResiduals: boolean | undefined, config: Record<string, unknown> = {}): Promise<AbacModel> {
  const m = new AbacModel({ stores: [new ConfigPolicyStore(policies)], ...(scopeResiduals === undefined ? {} : { scopeResiduals }) });
  await m.init(fakeModelInitContext({ permissions: registry(), config }));
  return m;
}

async function engine(world: World, policies: readonly Policy[], algorithm: string, other?: { scopes: readonly ResourceRef[]; first: boolean }, scopeResiduals = true): Promise<Authorizer> {
  const abac = await abacModel(policies, scopeResiduals);
  const models: AuthorizationModel[] = [abac];
  if (other) models.splice(other.first ? 0 : 1, 0, new UnderModel(other.scopes));
  return new Authorizer({
    domain: 'root',
    models,
    registry: registry(),
    combine: { default: { algorithm, models: models.map((m) => m.name) } },
    scopeResolvers: [world.tree],
    nativeFilters: scopeResiduals ? [SCOPE_CONDITION_FILTER] : [],
    conditions: new DefaultConditionCompiler(),
    clock: () => NOW,
  });
}

/** What the type-level residual selects of one row in memory, its natives through SCOPE_CONDITION_FILTER. */
async function selects(residual: ResourceFilter, world: World, row: World['rows'][number], who: Principal): Promise<boolean> {
  const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [world.tree] as never, permissions: registry() });
  const env: SubjectEnv = { principal: who, ref: row.ref, attribute: defaultAttribute, relation: () => undefined, ancestors: (r) => ctx.ancestors(r), native: (op) => (op === SCOPE_CONDITION_OP ? SCOPE_CONDITION_FILTER : undefined), ctx };
  return (await evaluateResidual(residual, row.subject, env)) === true;
}

/** Row ids `check` allows and row ids the type-level filter selects. */
async function both(a: Authorizer, world: World, who: Principal): Promise<{ checked: string[]; listed: string[]; residual: ResourceFilter }> {
  const residual = await a.filter(who, 'file:read', 'file');
  const checked: string[] = [];
  const listed: string[] = [];
  for (const row of world.rows) {
    if ((await a.check({ principal: who, permission: 'file:read', resource: row.ref, subject: row.subject })).allowed) checked.push(row.ref.id!);
    if (await selects(residual, world, row, who)) listed.push(row.ref.id!);
  }
  return { checked, listed, residual };
}

const file = (id: string) => ({ ref: { type: 'file', id }, subject: {} });

// The B19 world: o1 frozen, o2 open, o3 without the attributes, o4 an unknown node; f5 has no org.
const B19: World = {
  tree: new Tree({ 'org:o1': null, 'org:o2': null, 'org:o3': null, 'org:o4': null, 'project:p1': { type: 'org', id: 'o2' }, 'file:f1': { type: 'org', id: 'o1' }, 'file:f2': { type: 'org', id: 'o2' }, 'file:f3': { type: 'org', id: 'o3' }, 'file:f4': { type: 'org', id: 'o4' }, 'file:f5': null, 'file:f6': { type: 'project', id: 'p1' } }, { 'org:o1': { policies: { frozen: true, open: false } }, 'org:o2': { policies: { frozen: false, open: true } }, 'org:o3': {}, 'org:o4': null }),
  rows: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map(file),
};
const FROZEN = policy('frozen', { effect: 'deny', when: { attr: 'scope.org.policies.frozen', eq: true } });
const OPEN = policy('open-orgs', { when: { attr: 'scope.org.policies.open', eq: true } });
const ALL = policy('all');

describe('authz-abac: scope conditions as residual leaves (RFC K1b-1)', () => {
  describe('the switch', () => {
    it('is off by default; the schema says false; the option wins over the config', async () => {
      expect((AUTHZ_ABAC_CONFIGURATION_SCHEMA.properties as Record<string, unknown>).scopeResiduals).to.deep.equal({ type: 'boolean', default: false });
      expect((await abacModel([OPEN], undefined)).capabilities.residuals).to.not.include(SCOPE_CONDITION_OP);
      expect((await abacModel([OPEN], undefined, { scopeResiduals: true })).capabilities.residuals).to.include(SCOPE_CONDITION_OP);
      expect((await abacModel([OPEN], false, { scopeResiduals: true })).capabilities.residuals).to.not.include(SCOPE_CONDITION_OP);
      expect((await abacModel([OPEN], true, { scopeResiduals: false })).capabilities.residuals).to.include(SCOPE_CONDITION_OP);
    });

    it('registers SCOPE_CONDITION_FILTER at init only when on', async () => {
      for (const on of [true, false]) {
        const ctx = fakeModelInitContext({ permissions: registry(), config: { scopeResiduals: on } });
        await new AbacModel({ stores: [new ConfigPolicyStore([OPEN])] }).init(ctx);
        expect(ctx.registered.nativeFilters).to.deep.equal(on ? [SCOPE_CONDITION_FILTER] : []);
      }
    });

    it('refuses a config value that is not a boolean', async () => {
      let error: unknown;
      await abacModel([OPEN], undefined, { scopeResiduals: 'yes' }).catch((e) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.match(/authz\.abac\.scopeResiduals must be a boolean/);
    });
  });

  describe('switch off: today’s type-level answers', () => {
    it('a deny reading scope.* denies needs_subject everywhere (B19); a permit is indeterminate (B39)', async () => {
      const deny = await engine(B19, [ALL, FROZEN], 'deny-overrides', undefined, false);
      const d = await deny.check({ principal: alice, permission: 'file:read', resource: { type: 'file' } });
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('needs_subject');
      const permit = await engine(B19, [OPEN], 'deny-overrides', undefined, false);
      const p = await permit.check({ principal: alice, permission: 'file:read', resource: { type: 'file' } });
      expect(p.allowed).to.equal(false);
      expect(p.reason?.code).to.equal('model_error');
    });
  });

  describe('switch on', () => {
    it('the B19 world: the type-level check is conditional and the filter lists exactly what check allows', async () => {
      const a = await engine(B19, [FROZEN, OPEN], 'deny-overrides');
      const d = await a.check({ principal: alice, permission: 'file:read', resource: { type: 'file' } });
      expect(d.allowed).to.equal(true);
      expect(d.residual.op).to.not.be.oneOf(['true', 'false']);
      const { checked, listed } = await both(a, B19, alice);
      expect(checked).to.deep.equal(['f2', 'f6']);
      expect(listed).to.deep.equal(checked);
    });

    it('a deny alone with an unconditional permit: frozen and fault rows go, the rest stay', async () => {
      const { checked, listed } = await both(await engine(B19, [ALL, FROZEN], 'deny-overrides'), B19, alice);
      expect(checked).to.deep.equal(['f2', 'f6']);
      expect(listed).to.deep.equal(checked);
    });

    it('a fault row makes ABAC indeterminate row by row under every algorithm, as the row check does', async () => {
      const others = [
        undefined,
        {
          scopes: [
            { type: 'org', id: 'o3' },
            { type: 'org', id: 'o1' },
          ],
          first: false,
        },
        {
          scopes: [
            { type: 'org', id: 'o3' },
            { type: 'org', id: 'o1' },
          ],
          first: true,
        },
      ];
      const want: Record<string, string[]> = {
        'deny-overrides|0': ['f2', 'f6'],
        'deny-overrides|1': ['f2', 'f6'],
        'deny-overrides|2': ['f2', 'f6'],
        'permit-overrides|0': ['f2', 'f6'],
        // The other model permits under o3 and o1: ABAC's fault on f3 and its deny on f1 do not take that away.
        'permit-overrides|1': ['f1', 'f2', 'f3', 'f6'],
        'permit-overrides|2': ['f1', 'f2', 'f3', 'f6'],
        'first-applicable|0': ['f2', 'f6'],
        // ABAC first applies everywhere (its deny on f1, its fault on f3); the other model first decides f1 and f3.
        'first-applicable|1': ['f2', 'f6'],
        'first-applicable|2': ['f1', 'f2', 'f3', 'f6'],
      };
      for (const algorithm of ALGORITHMS) {
        for (const [i, other] of others.entries()) {
          const { checked, listed } = await both(await engine(B19, [ALL, FROZEN, OPEN], algorithm, other), B19, alice);
          expect(checked, `${algorithm} ${i}`).to.deep.equal(want[`${algorithm}|${i}`]);
          expect(listed, `${algorithm} ${i}`).to.deep.equal(checked);
        }
      }
    });

    it('a policy whose condition folds to FALSE still guards the rows where its scope read faults', async () => {
      const bobOnly = policy('bob-open', {
        when: {
          all: [
            { attr: 'principal.id', eq: 'bob' },
            { attr: 'scope.org.policies.open', eq: true },
          ],
        },
      });
      const { checked, listed } = await both(await engine(B19, [ALL, bobOnly], 'deny-overrides'), B19, alice);
      expect(checked).to.deep.equal(['f1', 'f2', 'f6']);
      expect(listed).to.deep.equal(checked);
    });

    it('a scoped policy guards only the rows under its scope', async () => {
      const scoped = { ...FROZEN, scope: { type: 'org', id: 'o1' } };
      const { checked, listed } = await both(await engine(B19, [ALL, scoped], 'deny-overrides'), B19, alice);
      expect(checked).to.deep.equal(['f2', 'f3', 'f4', 'f5', 'f6']);
      expect(listed).to.deep.equal(checked);
    });

    it('a guard entry in denies says model_error for its policy and carries no fields', async () => {
      const m = await abacModel([ALL, { ...FROZEN, fields: { hide: ['secret'] } }], true);
      const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [B19.tree] as never, permissions: registry(), conditions: new DefaultConditionCompiler() });
      const v = await m.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file' }, env: { now: NOW } }, ctx);
      expect(v.denies?.map((d) => d.reason)).to.deep.equal([
        { code: 'model_error', policy: 'frozen', sortKey: 'frozen' },
        { code: 'policy', policy: 'frozen', priority: 500, sortKey: 'frozen' },
      ]);
      expect(v.fields).to.deep.equal({ read: ['*'], write: ['*'], hide: ['secret'] });
      // As normalizeVote makes an indeterminate vote: permit FALSE and deny TRUE where the read faults.
      const fault: ResourceFilter = { op: SCOPE_CONDITION_OP, args: { v: 1, test: 'fault', type: 'org', path: 'policies.frozen' } };
      expect(v.permitWhen).to.deep.equal(and(not(fault), TRUE));
      expect((v.denyWhen as { args: ResourceFilter[] }).args[0]).to.deep.equal(fault);
    });

    it('a request by id and a $global type-level request keep today’s path', async () => {
      const m = await abacModel([OPEN], true);
      const ctx = fakeEvaluationContext({ now: NOW, scopeResolvers: [B19.tree] as never, permissions: registry(), conditions: new DefaultConditionCompiler() });
      const byId = await m.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file', id: 'f2' }, env: { now: NOW } }, ctx);
      expect(byId.permitWhen).to.deep.equal({ op: 'true' });
      let error: unknown;
      await Promise.resolve(m.evaluate({ principal: alice, permission: 'file:read', resource: { type: 'file', id: 'f3' }, env: { now: NOW } }, ctx)).catch((e) => (error = e));
      expect((error as Error).message).to.match(/has no such attribute/);
      error = undefined;
      await Promise.resolve(m.evaluate({ principal: alice, permission: 'file:read', resource: { type: '$global' }, env: { now: NOW } }, ctx)).catch((e) => (error = e));
      expect((error as Error).message).to.match(/abac policy "open-orgs": its condition reads scope attributes/);
    });

    it('listWarnings leaves out a policy whose every row read is a leaf', async () => {
      const operandRef = policy('operand', { when: { attr: 'resource.tier', eq: { ref: 'scope.org.policies.level' } } });
      const named = policy('named', { when: { fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'a/*' } } });
      const mixed = policy('mixed', {
        effect: 'deny',
        when: {
          any: [
            { attr: 'scope.org.policies.frozen', eq: true },
            { attr: 'principal.id', eq: { ref: 'scope.org.owner' } },
          ],
        },
      });
      const policies = [FROZEN, OPEN, operandRef, named, mixed];
      const ids = (lines: readonly string[]) => lines.map((l) => /policy "([^"]+)"/.exec(l)?.[1]);
      expect(ids((await abacModel(policies, false)).listWarnings(['file']))).to.deep.equal(['frozen', 'open-orgs', 'operand', 'named', 'mixed']);
      expect(ids((await abacModel(policies, true)).listWarnings(['file']))).to.deep.equal(['operand', 'named', 'mixed']);
    });
  });

  describe('check(row).allowed ⇔ the type-level filter selects the row (property)', () => {
    const SCOPE_ATTRS = ['scope.org.a', 'scope.org.b.c', 'scope.project.a'] as const;
    const value = fc.constantFrom<unknown>('a', 'b', '1', '2', 1, 2, 0, true, false, null, ['a', 1], { c: 'a' }, { c: 1 }, { c: null });
    const attrs = fc.record({ a: fc.option(value, { nil: undefined, freq: 3 }), b: fc.option(fc.oneof(value, fc.record({ c: value })), { nil: undefined, freq: 3 }) }).map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
    const scalar = fc.constantFrom<string | number | boolean>('a', 'b', '1', '2', 1, 2, 0, true, false);
    const operand = <T>(a: fc.Arbitrary<T>) => fc.oneof({ weight: 4, arbitrary: a }, { weight: 1, arbitrary: fc.constantFrom('principal.attributes.pool', 'principal.attributes.teams', 'principal.attributes.missing', 'actor.type', 'env.region').map((r) => ({ ref: r })) });
    const scopeLeaf: fc.Arbitrary<Condition> = fc.tuple(fc.constantFrom(...SCOPE_ATTRS), fc.oneof(fc.tuple(fc.constantFrom('eq', 'ne'), operand(scalar)), fc.tuple(fc.constantFrom('in', 'nin'), operand(fc.array(fc.constantFrom<string | number>('a', 'b', '1', 1, 2), { maxLength: 3 }))), fc.tuple(fc.constantFrom('lt', 'gte'), operand(fc.constantFrom<string | number>('a', '1', 1, 2))), fc.tuple(fc.constantFrom('like', 'wildcard'), operand(fc.constantFrom('a%', '*', 'b*'))), fc.tuple(fc.constant('null'), fc.boolean()))).map(([attr, [op, v]]) => ({ attr, [op]: v } as Condition));
    const other: fc.Arbitrary<Condition> = fc.oneof(fc.record({ attr: fc.constant('principal.attributes.pool'), eq: fc.constantFrom('gold', 'x') }), fc.record({ attr: fc.constant('resource.status'), eq: fc.constantFrom<unknown>('open', 1) }), fc.record({ attr: fc.constant('actor.type'), eq: fc.constantFrom('agent', 'user') })) as fc.Arbitrary<Condition>;
    const { tree: conditionArb } = fc.letrec<{ tree: Condition }>((tie) => ({
      tree: fc.oneof(
        { depthSize: 'small', maxDepth: 3, withCrossShrink: true },
        fc.oneof({ weight: 4, arbitrary: scopeLeaf }, { weight: 1, arbitrary: other }),
        fc.array(tie('tree'), { maxLength: 3 }).map((all) => ({ all })),
        fc.array(tie('tree'), { maxLength: 3 }).map((any) => ({ any })),
        tie('tree').map((c) => ({ not: c })),
      ),
    }));
    const SCOPES: (ResourceRef | undefined)[] = [undefined, undefined, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, { type: 'project', id: 'p1' }, { type: 'org' }];
    const policyArb = fc.record({ effect: fc.constantFrom<'permit' | 'deny'>('permit', 'deny'), scope: fc.constantFrom(...SCOPES), when: fc.option(conditionArb, { nil: undefined, freq: 6 }), actorTypes: fc.constantFrom<readonly string[] | undefined>(undefined, undefined, ['agent'], ['user']) });
    const parentArb = fc.constantFrom<ResourceRef | null>(null, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, { type: 'org', id: 'o3' }, { type: 'org' }, { type: 'project', id: 'p1' });
    const worldArb = fc.record({
      o1: attrs,
      o2: fc.option(attrs, { nil: null, freq: 4 }),
      p1: attrs,
      p1parent: fc.constantFrom<ResourceRef | null>(null, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }),
      rows: fc.array(fc.record({ parent: parentArb, status: fc.constantFrom<unknown>('open', 'closed', 1, undefined) }), { minLength: 1, maxLength: 4 }),
      policies: fc.array(policyArb, { minLength: 1, maxLength: 4 }),
      unconditional: fc.boolean(),
      algorithm: fc.constantFrom(...ALGORITHMS),
      other: fc.constantFrom<undefined | { scopes: readonly ResourceRef[]; first: boolean }>(undefined, { scopes: [{ type: 'org', id: 'o1' }], first: false }, { scopes: [{ type: 'org', id: 'o3' }], first: true }),
      who: fc.constantFrom<'user' | 'inherit' | 'intersect'>('user', 'inherit', 'intersect'),
    });

    it('for random policy sets, trees, algorithms and principals', async function () {
      this.timeout(300_000);
      const seen = { allowed: 0, denied: 0 };
      await fc.assert(
        fc.asyncProperty(worldArb, async (w) => {
          const parents: Record<string, ResourceRef | null> = { 'org:o1': null, 'org:o2': null, 'org:o3': null, 'project:p1': w.p1parent };
          w.rows.forEach((r, i) => (parents[`file:f${i}`] = r.parent));
          const world: World = { tree: new Tree(parents, { 'org:o1': w.o1, 'org:o2': w.o2, 'org:o3': null, 'project:p1': w.p1 }), rows: w.rows.map((r, i) => ({ ref: { type: 'file', id: `f${i}` }, subject: r.status === undefined ? {} : { status: r.status } })) };
          const policies: Policy[] = w.policies.map((p, i) => policy(`p${i}`, { effect: p.effect, ...(p.scope ? { scope: p.scope } : {}), ...(p.when ? { when: p.when } : {}), ...(p.actorTypes ? { actorTypes: p.actorTypes } : {}) }));
          if (w.unconditional) policies.push(ALL);
          const who = w.who === 'user' ? alice : agentPrincipal('ag1', alice, { delegation: w.who });
          const a = await engine(world, policies, w.algorithm, w.other);
          const { checked, listed, residual } = await both(a, world, who);
          expect(listed, `${JSON.stringify(policies)} ${w.algorithm} ${w.who} ${JSON.stringify(w.other)}: ${JSON.stringify(residual)}`).to.deep.equal(checked);
          seen.allowed += checked.length;
          seen.denied += world.rows.length - checked.length;
        }),
        { numRuns: 300, seed: 4102 },
      );
      expect(seen.allowed > 100 && seen.denied > 100, JSON.stringify(seen)).to.equal(true);
    });
  });
});
