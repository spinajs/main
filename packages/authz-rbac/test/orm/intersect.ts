import { Authorizer, CORE_FILTER_OPS, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { NativeFilter, Principal, ResourceFilter } from '@spinajs/authz';
import { FakeAdapter, FakeScopeResolver, fakeModelInitContext } from '@spinajs/authz-testing';
import type { OrmDriver } from '@spinajs/orm';
import { expect } from 'chai';

import { MemoryAssignmentStore, MemoryRoleStore, RBAC_ASSIGNMENT_OP, RbacModel, createRbacExtensions, rbacAssignmentExtension } from '../../src/index.js';
import { ASSIGNMENTS, DOCS, NOW, ROLE_DEFS, compilerContainer, visibleDocs } from './fixture.js';

const u1 = { type: 'user', id: 'u1', authenticated: true, source: 'session', attributes: {} } as Principal;
const svcAlone = { type: 'service', id: 'svc', authenticated: true, source: 'session', attributes: {} } as Principal;
const svc = { ...svcAlone, onBehalfOf: u1, delegation: 'intersect' } as Principal;

/** An Authorizer over the RbacModel with rbacAssignmentExtension, the fixture's roles and assignments (svc: a viewer at GLOBAL, in memory only). */
async function authorizer() {
  const registry = new PermissionRegistryImpl();
  registry.register([{ name: 'doc:read', types: ['doc', 'project', 'org'] }], 'test');
  registry.freeze();
  const base = { roles: new MemoryRoleStore(ROLE_DEFS, []), assignments: new MemoryAssignmentStore([...ASSIGNMENTS, { id: 'svc', subject: { type: 'service', id: 'svc' }, role: 'viewer', scope: GLOBAL, source: 'test' }]) };
  const model = new RbacModel({ ...base, extensions: [...createRbacExtensions(base), rbacAssignmentExtension(base)], log: { warn: () => undefined } });
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  model.grantIndex();
  const natives = model.extensions.flatMap((e) => e.nativeFilters?.() ?? []) as NativeFilter[];
  const docs = DOCS.map(([id]) => ({ id: String(id) }));
  // DOC_PATH's tree: doc → project → org.
  const parents = DOCS.flatMap(([id, projectId, orgId]) => [
    [
      { type: 'doc', id: String(id) },
      { type: 'project', id: String(projectId) },
    ] as const,
    [
      { type: 'project', id: String(projectId) },
      { type: 'org', id: orgId },
    ] as const,
  ]);
  const adapter = new FakeAdapter({ types: ['doc'], rows: { doc: docs }, parents, compiles: [...CORE_FILTER_OPS, RBAC_ASSIGNMENT_OP] });
  const scopes = new FakeScopeResolver({ types: ['project', 'org'], nodes: DOCS.map(([, projectId, orgId]) => ({ ref: { type: 'project', id: String(projectId) }, parent: { type: 'org', id: orgId } })) });
  const authz = new Authorizer({ domain: 'root', models: [model], registry, adapters: [adapter], scopeResolvers: [scopes], nativeFilters: natives, clock: () => NOW });
  return { authz, adapter };
}

/** The doc ids a type-level residual selects in SQL, each native:rbac.assignment term compiled with `principal` (which the compiler ignores). */
async function sqlDocs(driver: OrmDriver, residual: ResourceFilter, principal: Principal): Promise<number[]> {
  if (residual.op === 'true') return DOCS.map(([id]) => id);
  if (residual.op === 'false') return [];
  if (residual.op === 'or') {
    const parts = await Promise.all(residual.args.map((r) => sqlDocs(driver, r, principal)));
    return [...new Set(parts.flat())].sort((a, b) => a - b);
  }
  if (residual.op !== RBAC_ASSIGNMENT_OP) throw new Error(`not a native list term: ${JSON.stringify(residual)}`);
  return visibleDocs(driver, compilerContainer().compiler, residual.args, undefined, principal);
}

/**
 * RFC E2-2 at the SQL compiler: an intersect agent's filter keeps its delegate's
 * native:rbac.assignment term, and the SQL compiled from it with the agent as principal lists
 * exactly the rows the agent's checks allow. Not through the authz-orm middleware: it refuses
 * RbacOrmCompiler's lazy EXISTS for every principal until L4b moves it to @spinajs/authz-orm/native.
 */
export function intersectCases(db: () => OrmDriver): void {
  it("an intersect agent's filter keeps the delegate's native term: SQL lists exactly the docs its checks allow (RFC E2-2)", async () => {
    const { authz, adapter } = await authorizer();
    const filter = await authz.filter(svc, 'doc:read', 'doc');
    expect(JSON.stringify(filter), 'the kept term names u1').to.include('"id":"u1"');
    const listed = await sqlDocs(db(), filter, svc);
    const allowed: number[] = [];
    for (const [id] of DOCS) {
      const row = (await adapter.load({ type: 'doc', id: String(id) }))!;
      const check = async (principal: Principal) => (await authz.check({ principal, permission: 'doc:read', resource: row })).allowed;
      const agent = await check(svc);
      expect(agent, `doc ${id}: svc's check vs u1's ∧ svc's own`).to.equal((await check(u1)) && (await check(svcAlone)));
      if (agent) allowed.push(id);
    }
    expect(listed, JSON.stringify(filter)).to.deep.equal(allowed);
    expect(allowed).to.deep.equal([1, 2, 3, 5, 6]);
  });
}
