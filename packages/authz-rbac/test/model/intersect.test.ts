import { Authorizer, CORE_FILTER_OPS, DefaultConditionCompiler, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, NativeFilter, Principal, ResourceFilter, ResourceRef, RuleDef } from '@spinajs/authz';
import { FakeAdapter, FakeScopeResolver, evaluateFilter, fakeEvaluationContext, fakeModelInitContext } from '@spinajs/authz-testing';
import type { FakeRow } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP, RbacAssignmentFilter, RbacModel, createRbacExtensions, rbacAssignmentExtension } from '../../src/index.js';
import type { RoleDef, RuleStore } from '../../src/index.js';
import { RbacThresholdFilter } from '../../src/model/rules/native.js';

const expect = chai.expect;

// RFC E2-2: the RBAC list terms name their principal in the args, so an intersect delegate's residual keeps them.
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
  registry.register([{ name: 'file:read', types: ['project', 'file'] }], 'test');
  registry.freeze();
  const assignments: Assignment[] = [
    { id: 'a1', subject: { type: 'user', id: 'bob' }, role: 'viewer', scope: opts.bobAt, source: 'test' },
    { id: 'a2', subject: { type: 'service', id: 'svc' }, role: 'viewer', scope: opts.svcAt ?? GLOBAL, source: 'test' },
  ];
  const config = new ConfigRuleStore((opts.rules ?? []).map((r) => ({ ...r, source: 'test' })));
  const remote: RuleStore = { name: 'remote', forPath: () => Promise.resolve([]), version: () => Promise.resolve('remote:0') };
  const base = { roles: new MemoryRoleStore(ROLES, [{ name: 'project', roles: ['viewer', 'editor'] }]), assignments: new MemoryAssignmentStore(assignments), rules: opts.db ? [config, remote] : config };
  const model = new RbacModel({ ...base, extensions: [...createRbacExtensions(base), rbacAssignmentExtension(base, { rules: true })], log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  model.grantIndex();
  const natives = model.extensions.flatMap((e) => e.nativeFilters?.() ?? []) as NativeFilter[];
  const scopes = new FakeScopeResolver({ types: ['project'], nodes: [{ ref: P1 }, { ref: P2 }] });
  const adapter = new FakeAdapter({ types: ['file'], rows: { file: ROWS.map(({ parent: _parent, ...row }) => row) }, parents: ROWS.map((r) => [{ type: 'file', id: r.id }, r.parent] as const), compiles: [...CORE_FILTER_OPS, RBAC_ASSIGNMENT_OP, RBAC_THRESHOLD_OP] });
  const conditions = new DefaultConditionCompiler(undefined, [scopes]);
  const authz = new Authorizer({ domain: 'root', models: [model], registry, adapters: [adapter], scopeResolvers: [scopes], nativeFilters: natives, conditions, log: { error: () => undefined, warn: () => undefined, debug: () => undefined } });
  const context = () => fakeEvaluationContext({ adapters: [adapter], scopeResolvers: [scopes], conditions, nativeFilters: natives });
  return { authz, adapter, context };
}

const holdsRbacOp = (f: ResourceFilter): boolean => {
  if (f.op === RBAC_ASSIGNMENT_OP || f.op === RBAC_THRESHOLD_OP) return true;
  if (f.op === 'and' || f.op === 'or') return f.args.some(holdsRbacOp);
  return f.op === 'not' && holdsRbacOp(f.arg);
};

/**
 * For every row: svc's check ⇔ svc's filter on the row ⇔ bob's check ∧ svc's own check. Returns
 * the rows svc may read.
 */
async function agree(w: Awaited<ReturnType<typeof world>>): Promise<string[]> {
  const filter = await w.authz.filter(svc, 'file:read', 'file');
  expect(holdsRbacOp(filter), `svc's filter keeps bob's RBAC list terms: ${JSON.stringify(filter)}`).to.equal(true);
  const allowed: string[] = [];
  for (const { id } of ROWS) {
    const row = (await w.adapter.load({ type: 'file', id }))!;
    const ref = { type: 'file', id };
    const check = await w.authz.check({ principal: svc, permission: 'file:read', resource: row });
    // The kept terms name bob in their args: who evaluates the filter does not matter.
    const listed = (await evaluateFilter(filter, row, { principal: svc, ref, context: w.context() })) === true;
    const own = (await w.authz.check({ principal: svcAlone, permission: 'file:read', resource: row })).allowed;
    const delegate = (await w.authz.check({ principal: bob, permission: 'file:read', resource: row })).allowed;
    expect(check.allowed, `${id}: check ${JSON.stringify(check.reason)} vs filter ${JSON.stringify(filter)}`).to.equal(listed);
    expect(check.allowed, `${id}: check vs bob ∧ svc`).to.equal(delegate && own);
    if (!check.allowed && own) expect(check.reason?.code, id).to.equal('delegate');
    if (check.allowed) allowed.push(id);
  }
  return allowed;
}

describe('authz-rbac: an intersect agent over a delegate whose list vote is native (RFC E2-2)', () => {
  it('both list filters declare principalInArgs', () => {
    const base = { roles: new MemoryRoleStore(ROLES, []), assignments: new MemoryAssignmentStore([]) };
    const filters = rbacAssignmentExtension(base, { rules: true }).nativeFilters!();
    expect(filters.map((f) => [f.constructor, f.principalInArgs])).to.deep.equal([
      [RbacAssignmentFilter, true],
      [RbacThresholdFilter, true],
    ]);
  });

  it('a GLOBAL role and a DB rule store with no rules: every row', async () => {
    expect(await agree(await world({ bobAt: GLOBAL, db: true }))).to.deep.equal(['f1', 'f2', 'f3', 'f4']);
  });

  it('a role at p1, config rules only (args v1): the rows under p1', async () => {
    expect(await agree(await world({ bobAt: P1 }))).to.deep.equal(['f1', 'f2']);
  });

  it('a role at p1 and a DB rule store (args v2): the rows under p1', async () => {
    expect(await agree(await world({ bobAt: P1, db: true }))).to.deep.equal(['f1', 'f2']);
  });

  it("svc's own role at p2 is narrower than bob's GLOBAL one, config rules only: svc's own model decides, the rows under p2", async () => {
    expect(await agree(await world({ bobAt: GLOBAL, svcAt: P2 }))).to.deep.equal(['f3', 'f4']);
  });

  it("svc's own role at p2 is narrower than bob's GLOBAL one, with a DB rule store: svc's own model decides, the rows under p2", async () => {
    expect(await agree(await world({ bobAt: GLOBAL, svcAt: P2, db: true }))).to.deep.equal(['f3', 'f4']);
  });

  it('bob at p1 and svc at p2: the intersection is empty', async () => {
    expect(await agree(await world({ bobAt: P1, svcAt: P2, db: true }))).to.deep.equal([]);
  });

  it("a threshold rule for users denies bob's secret rows: the kept `not native:rbac.threshold` still denies them for svc", async () => {
    const rules = [{ id: 'secrets', kind: 'threshold' as const, scope: GLOBAL, subjects: { principalTypes: ['user'] }, permissions: ['file:read'], minRole: 'editor', resource: { attr: 'resource.name', wildcard: 'secret*' } }];
    const w = await world({ bobAt: GLOBAL, rules });
    // svc is no user: its own model allows the secret rows.
    for (const { id } of ROWS) expect((await w.authz.check({ principal: svcAlone, permission: 'file:read', resource: (await w.adapter.load({ type: 'file', id }))! })).allowed, id).to.equal(true);
    expect(JSON.stringify(await w.authz.filter(svc, 'file:read', 'file'))).to.include(RBAC_THRESHOLD_OP);
    expect(await agree(w)).to.deep.equal(['f1', 'f3']);
  });
});
