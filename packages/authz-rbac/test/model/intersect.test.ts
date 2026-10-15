import { Authorizer, CORE_FILTER_OPS, DefaultConditionCompiler, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, Principal, ResourceRef, RuleDef } from '@spinajs/authz';
import { FakeAdapter, FakeScopeResolver, evaluateFilter, fakeEvaluationContext, fakeModelInitContext } from '@spinajs/authz-testing';
import type { FakeRow } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, createRbacExtensions } from '../../src/index.js';
import type { RoleDef, RuleStore } from '../../src/index.js';

const expect = chai.expect;

const P1: ResourceRef = { type: 'project', id: 'p1' };
const P2: ResourceRef = { type: 'project', id: 'p2' };
const ROWS: readonly (FakeRow & { readonly parent: ResourceRef })[] = [
  { id: 'f1', name: 'notes', parent: P1 },
  { id: 'f2', name: 'secret-1', parent: P1 },
  { id: 'f3', name: 'plan', parent: P2 },
  { id: 'f4', name: 'secret-2', parent: P2 },
];

const user = (id: string): Principal => ({ type: 'user', id, authenticated: true, source: 'session', attributes: {} } as Principal);
const bob = user('bob');
const svcAlone = { type: 'service', id: 'svc', authenticated: true, source: 'session', attributes: {} } as Principal;
const svc = { ...svcAlone, onBehalfOf: bob, delegation: 'intersect' } as Principal;

const ROLES: RoleDef[] = [
  { name: 'viewer', extends: [], assignable: true, source: 'test', ladder: 'project', grants: [{ permission: 'file:read' }] },
  { name: 'editor', extends: ['viewer'], assignable: true, source: 'test', ladder: 'project', grants: [] },
];

interface WorldOptions {
  /** Where bob's viewer role sits. */
  readonly bobAt: ResourceRef;
  /** Where svc's own viewer role sits (GLOBAL by default). */
  readonly svcAt?: ResourceRef;
  /** A rule store that is not in memory (no rules in it), beside the config one. */
  readonly db?: boolean;
  readonly rules?: readonly Omit<RuleDef, 'source'>[];
}

async function world(opts: WorldOptions) {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'file:read', types: ['project', 'file'], list: true }], 'test');
  registry.freeze();
  const assignments: Assignment[] = [
    { id: 'a1', subject: { type: 'user', id: 'bob' }, role: 'viewer', scope: opts.bobAt, source: 'test' },
    { id: 'a2', subject: { type: 'service', id: 'svc' }, role: 'viewer', scope: opts.svcAt ?? GLOBAL, source: 'test' },
  ];
  const config = new ConfigRuleStore((opts.rules ?? []).map((r) => ({ ...r, source: 'test' })));
  const remote: RuleStore = { name: 'remote', forPath: () => Promise.resolve([]), version: () => Promise.resolve('remote:0') };
  const base = { roles: new MemoryRoleStore(ROLES, [{ name: 'project', roles: ['viewer', 'editor'] }]), assignments: new MemoryAssignmentStore(assignments), rules: opts.db ? [config, remote] : config };
  const model = new RbacModel({ ...base, extensions: createRbacExtensions(base), log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  model.grantIndex();
  const scopes = new FakeScopeResolver({ types: ['project'], nodes: [{ ref: P1 }, { ref: P2 }] });
  const adapter = new FakeAdapter({ types: ['file'], rows: { file: ROWS.map(({ parent: _parent, ...row }) => row) }, parents: ROWS.map((r) => [{ type: 'file', id: r.id }, r.parent] as const), compiles: CORE_FILTER_OPS });
  const conditions = new DefaultConditionCompiler(undefined, [scopes]);
  const authz = new Authorizer({ domain: 'root', models: [model], registry, adapters: [adapter], scopeResolvers: [scopes], conditions, log: { error: () => undefined, warn: () => undefined, debug: () => undefined } });
  const context = () => fakeEvaluationContext({ adapters: [adapter], scopeResolvers: [scopes], conditions });
  return { authz, adapter, context };
}

/**
 * For every row: svc's check ⇔ svc's type-level residual on the row, and a denial while svc's own check
 * allows is `delegate`. Returns the rows svc may read and those bob ∧ svc may read one by one. An intersect
 * agent has no list path (accessPlan is `none delegate`).
 */
async function agree(w: Awaited<ReturnType<typeof world>>): Promise<{ allowed: string[]; both: string[] }> {
  const plan = await w.authz.accessPlan(svc, 'file:read', 'file');
  expect(plan.kind === 'none' && plan.reason.code, JSON.stringify(plan)).to.equal('delegate');
  const filter = await w.authz.filter(svc, 'file:read', 'file');
  const allowed: string[] = [];
  const both: string[] = [];
  for (const { id } of ROWS) {
    const row = (await w.adapter.load({ type: 'file', id }))!;
    const ref = { type: 'file', id };
    const check = await w.authz.check({ principal: svc, permission: 'file:read', resource: row });
    const listed = (await evaluateFilter(filter, row, { principal: svc, ref, context: w.context() })) === true;
    const own = (await w.authz.check({ principal: svcAlone, permission: 'file:read', resource: row })).allowed;
    const delegate = (await w.authz.check({ principal: bob, permission: 'file:read', resource: row })).allowed;
    expect(check.allowed, `${id}: check ${JSON.stringify(check.reason)} vs filter ${JSON.stringify(filter)}`).to.equal(listed);
    if (!check.allowed && own) expect(check.reason?.code, id).to.equal('delegate');
    if (check.allowed) allowed.push(id);
    if (delegate && own) both.push(id);
  }
  return { allowed, both };
}

/** The rows svc reads, which are those bob ∧ svc read one by one. */
async function intersection(w: Awaited<ReturnType<typeof world>>): Promise<string[]> {
  const { allowed, both } = await agree(w);
  expect(allowed, 'svc vs bob ∧ svc').to.deep.equal(both);
  return allowed;
}

describe('authz-rbac: an intersect agent over an RBAC delegate (checks)', () => {
  it('a GLOBAL role, config rules only: every row', async () => {
    expect(await intersection(await world({ bobAt: GLOBAL }))).to.deep.equal(['f1', 'f2', 'f3', 'f4']);
  });

  it('a role at p1, config rules only: the rows under p1', async () => {
    expect(await intersection(await world({ bobAt: P1 }))).to.deep.equal(['f1', 'f2']);
  });

  it("svc's own role at p2 is narrower than bob's GLOBAL one: svc's own model decides, the rows under p2", async () => {
    expect(await intersection(await world({ bobAt: GLOBAL, svcAt: P2 }))).to.deep.equal(['f3', 'f4']);
  });

  it('bob at p1 and svc at p2: the intersection is empty', async () => {
    expect(await intersection(await world({ bobAt: P1, svcAt: P2 }))).to.deep.equal([]);
  });

  it("a DB rule store fails bob's type-level vote closed (model_error), so svc reads nothing although bob ∧ svc would", async () => {
    for (const [bobAt, svcAt, both] of [
      [GLOBAL, GLOBAL, ['f1', 'f2', 'f3', 'f4']],
      [P1, GLOBAL, ['f1', 'f2']],
      [GLOBAL, P2, ['f3', 'f4']],
    ] as const) {
      const w = await world({ bobAt, svcAt, db: true });
      expect((await w.authz.check({ principal: bob, permission: 'file:read', resource: { type: 'file' } })).reason).to.include({ code: 'model_error' });
      expect(await agree(w)).to.deep.equal({ allowed: [], both });
    }
  });

  it("a threshold rule for users denies bob's secret rows, so it denies them for svc too", async () => {
    const rules = [{ id: 'secrets', kind: 'threshold' as const, scope: GLOBAL, subjects: { principalTypes: ['user'] }, permissions: ['file:read'], minRole: 'editor', resource: { attr: 'resource.name', wildcard: 'secret*' } }];
    const w = await world({ bobAt: GLOBAL, rules });
    // svc is no user: its own model allows the secret rows.
    for (const { id } of ROWS) expect((await w.authz.check({ principal: svcAlone, permission: 'file:read', resource: (await w.adapter.load({ type: 'file', id }))! })).allowed, id).to.equal(true);
    expect(await intersection(w)).to.deep.equal(['f1', 'f3']);
  });
});
