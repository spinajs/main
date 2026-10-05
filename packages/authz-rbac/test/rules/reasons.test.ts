import { DEFAULT_DENY_PRIORITY, GLOBAL, PermissionRegistryImpl, TRUE, compareDenyReasons } from '@spinajs/authz';
import type { Assignment, DenyReason, PermissionInput, ResourceRef, RuleDef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const P1: ResourceRef = { type: 'project', id: 'p1' };
const f1: ResourceRef = { type: 'file', id: 'f1' };
const alice = userPrincipal('alice');

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });
const assignment = (id: string, roleName: string, scope: ResourceRef = GLOBAL): Assignment => ({ id, subject: { type: 'user', id: 'alice' }, role: roleName, scope, source: 'test' });
const threshold = (id: string, minRole: string, reason?: RuleDef['reason']): RuleDef => ({ id, kind: 'threshold', scope: GLOBAL, permissions: ['file:edit', 'code:view'], minRole, ...(reason ? { reason } : {}), source: 'test' });

const ROLES = [role('viewer', [], { ladder: 'project' }), role('editor', ['file:edit', { permission: 'code:view', requiresTag: 'code' }], { ladder: 'project' }), role('maintainer', [], { ladder: 'project' })];
const PERMISSIONS: PermissionInput[] = ['file:edit', 'code:view'].map((name) => ({ name, types: ['project', 'file'] }));
const scopes = new FakeScopeResolver({ types: ['project', 'file'], nodes: [{ ref: P1 }, { ref: f1, parent: P1 }] });

async function vote(roleName: string, permission: string, rules: readonly RuleDef[]): Promise<Vote> {
  const registry = new PermissionRegistryImpl();
  registry.register(PERMISSIONS, 'test');
  registry.freeze();
  const m = new RbacModel({ roles: new MemoryRoleStore(ROLES, [{ name: 'project', roles: ['viewer', 'editor', 'maintainer'] }]), assignments: new MemoryAssignmentStore([assignment('a1', roleName, P1)]), rules: new ConfigRuleStore(rules), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: registry }));
  return m.evaluate({ principal: alice, permission, resource: f1 }, fakeEvaluationContext({ now: NOW, scopeResolvers: [scopes] }));
}

/** The reason the engine reports: the lowest (priority, sortKey) over the vote's reason and its deny entries. */
const reported = (v: Vote): DenyReason => [...(v.reason ? [v.reason] : []), ...(v.denies ?? []).map((d) => d.reason)].sort(compareDenyReasons)[0];

const BRANCH = (pattern: string) => ({ code: 'branch_protected', pattern, priority: 700, sortKey: pattern });

describe('authz-rbac deny reasons (step 5-8 entries, B36)', () => {
  it('every failing threshold adds an entry with its priority (default 600) and sortKey', async () => {
    const v = await vote('editor', 'file:edit', [threshold('t-b', 'maintainer', BRANCH('b*')), threshold('t-a', 'maintainer', BRANCH('a*')), threshold('t-d', 'maintainer')]);
    expect(v.permitWhen).to.deep.equal(TRUE);
    expect(v.denies!.map((d) => d.reason)).to.have.deep.members([BRANCH('a*'), BRANCH('b*'), { code: 'threshold', rule: 't-d', priority: 600 }]);
    expect(reported(v)).to.deep.equal({ code: 'threshold', rule: 't-d', priority: 600 });
  });

  it('the entries and the reported reason do not depend on rule order', async () => {
    const rules = [threshold('t-1', 'maintainer', { code: 'slow', priority: 650 }), threshold('t-2', 'maintainer', BRANCH('b*')), threshold('t-3', 'maintainer', BRANCH('a*'))];
    const forward = await vote('editor', 'file:edit', rules);
    const backward = await vote('editor', 'file:edit', [...rules].reverse());
    expect(forward.denies).to.deep.equal(backward.denies);
    expect(reported(forward)).to.deep.equal(reported(backward));
    expect(reported(forward)).to.deep.equal({ code: 'slow', priority: 650 });
  });

  it('steps 5-6 give the non-permit reason, step 8 the deny entries: the lowest priority wins across them', async () => {
    const tooLow = await vote('viewer', 'file:edit', [threshold('t', 'maintainer', { code: 'policy' })]);
    expect(tooLow.reason).to.include({ code: 'role_too_low', priority: DEFAULT_DENY_PRIORITY.role_too_low });
    expect(reported(tooLow)).to.include({ code: 'role_too_low' });
    expect(reported(await vote('viewer', 'file:edit', [threshold('t', 'maintainer', { code: 'link_invalid', priority: 300 })]))).to.include({ code: 'link_invalid' });
    const tag = await vote('editor', 'code:view', [threshold('t', 'maintainer', { code: 'policy' })]);
    expect(reported(tag)).to.deep.equal({ code: 'tag_missing', tag: 'code', priority: DEFAULT_DENY_PRIORITY.tag_missing });
  });

  it('a threshold the rank meets adds no entry', async () => {
    expect((await vote('maintainer', 'file:edit', [threshold('t', 'maintainer', { code: 'policy' })])).denies).to.equal(undefined);
  });
});
