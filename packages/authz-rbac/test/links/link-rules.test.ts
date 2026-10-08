import { DefaultConditionCompiler, GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { Assignment, PermissionInput, Principal, ResourceRef, RuleDef } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAdminAssignmentStore, MemoryLinkStore, MemoryRoleStore, RbacModel, RbacService } from '../../src/index.js';
import type { GrantDef, LadderDef, RoleDef } from '../../src/index.js';
import { CANVAS_RULES } from '../rules/canvas-rules.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const r = (type: string, id: string): ResourceRef => ({ type, id });
const [O1, O2, P1, P2, f1, f2] = [r('org', 'o1'), r('org', 'o2'), r('project', 'p1'), r('project', 'p2'), r('file', 'f1'), r('file', 'f2')];
const role = (name: string, grants: readonly (string | GrantDef)[], ladder?: string): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...(ladder ? { ladder } : {}), grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor'] },
  { name: 'org', roles: ['org.guest', 'org.member'] },
];
const ROLES = [role('viewer', ['file:read', { permission: 'addon:use', requiresTag: 'addons' }], 'project'), role('commenter', ['file:comment'], 'project'), role('editor', ['file:edit'], 'project'), role('org.guest', [], 'org'), role('org.member', [], 'org')];
const PERMISSIONS: PermissionInput[] = ['file:read', 'file:comment', 'file:edit', 'addon:use'].map((name) => ({ name, types: ['org', 'project', 'file'] }));
// o1 limits links to viewer and strips their add-ons; o2 sets nothing.
const scopes = new FakeScopeResolver({
  types: ['org', 'project', 'file'],
  nodes: [
    { ref: O1, attributes: { policies: { max_link_role: 'viewer', addons_for_guests: false, public_links: true } } },
    { ref: O2, attributes: { policies: { max_link_role: 'editor', addons_for_guests: true, public_links: true } } },
    { ref: P1, parent: O1 },
    { ref: P2, parent: O2 },
    { ref: f1, parent: P1 },
    { ref: f2, parent: P2 },
  ],
});
const LINK_RULES = (CANVAS_RULES as Omit<RuleDef, 'source'>[]).filter((x) => ['link-cap', 'link-org-cap', 'link-addons', 'link-members-only'].includes(x.id)).map((x) => ({ ...x, source: 'config' } as RuleDef));

async function world() {
  const rows: Assignment[] = [
    { id: 'm1', subject: { type: 'user', id: 'alice' }, role: 'editor', scope: GLOBAL, source: 'test' },
    { id: 'm2', subject: { type: 'user', id: 'alice' }, role: 'org.member', scope: O1, source: 'test' },
  ];
  const assignments = new MemoryAdminAssignmentStore({ assignments: rows });
  const links = new MemoryLinkStore(assignments, {
    links: [
      { link: { id: 'l1', scope: P1, attributes: { org_only: false } }, token: 'tok-l1', role: 'editor', tags: ['addons'] },
      { link: { id: 'l2', scope: P2, attributes: { org_only: false } }, token: 'tok-l2', role: 'editor', tags: ['addons'] },
      { link: { id: 'l3', scope: P2, attributes: { org_only: true } }, token: 'tok-l3', role: 'viewer' },
    ],
  });
  const model = new RbacModel({ roles: new MemoryRoleStore(ROLES, LADDERS), assignments, rules: new ConfigRuleStore(LINK_RULES), links, log: { warn: () => undefined } });
  const reg = new PermissionRegistryImpl();
  reg.register(PERMISSIONS, 'test');
  reg.freeze();
  await model.init(fakeModelInitContext({ model: 'rbac', permissions: reg }));
  return { model, service: new RbacService(model) };
}

const allowed = async (model: RbacModel, principal: Principal, permission: string, resource: ResourceRef): Promise<boolean> => {
  const v = await Promise.resolve(model.evaluate({ principal, permission, resource }, fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes], conditions: new DefaultConditionCompiler(undefined, [scopes]) })));
  return v.permitWhen.op === 'true' && v.denyWhen.op === 'false';
};

describe('authz-rbac share links under the link rules of design §8.5', () => {
  it('link-cap clamps a link to commenter, link-org-cap to the org policy, link-addons strips its tags', async () => {
    const { model, service } = await world();
    const l1 = await service.principalForToken('tok-l1');
    expect(await Promise.all(['file:read', 'file:comment', 'file:edit', 'addon:use'].map((p) => allowed(model, l1, p, f1)))).to.deep.equal([true, false, false, false]);
    const l2 = await service.principalForToken('tok-l2');
    expect(await Promise.all(['file:read', 'file:comment', 'file:edit', 'addon:use'].map((p) => allowed(model, l2, p, f2)))).to.deep.equal([true, true, false, true]);
  });

  it("the companion's own assignments are no link assignments: the link caps leave them alone", async () => {
    const { model, service } = await world();
    expect(await allowed(model, await service.principalForToken('tok-l1', userPrincipal('alice')), 'file:edit', f1)).to.equal(true);
  });

  it('link-members-only: an org_only link without an org rank is denied, a public one passes', async () => {
    const { model, service } = await world();
    expect(await allowed(model, await service.principalForToken('tok-l3'), 'file:read', f2)).to.equal(false);
    expect(await allowed(model, await service.principalForToken('tok-l1'), 'file:read', f1)).to.equal(true);
  });
});
