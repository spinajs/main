import { GLOBAL, PermissionRegistryImpl } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';
import { fakeModelInitContext } from '@spinajs/authz-testing';
import * as chai from 'chai';
import 'mocha';

import { ConfigRuleStore, MemoryAssignmentStore, MemoryRoleStore, RbacModel, ruleCanMatch } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const role = (name: string, grants: readonly (string | GrantDef)[], extra: Partial<RoleDef> = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });

function registry() {
  const r = new PermissionRegistryImpl();
  r.register([{ name: 'doc:read', types: ['doc', 'project'], list: true }, { name: 'doc:write', types: ['doc'] }], 'test');
  r.freeze();
  return r;
}

async function support(roles: readonly RoleDef[], rules: readonly Omit<RuleDef, 'source'>[] = []) {
  const reg = registry();
  const m = new RbacModel({ roles: new MemoryRoleStore(roles), assignments: new MemoryAssignmentStore(), ...(rules.length > 0 ? { rules: new ConfigRuleStore(rules as RuleDef[]) } : {}), log: { warn: () => undefined } });
  await m.init(fakeModelInitContext({ model: 'rbac', permissions: reg }));
  m.grantIndex();
  return m.listSupport(reg.require('doc:read'), 'doc');
}

describe('authz-rbac listSupport (design §7)', () => {
  it('is true for plain, owner, self, grantedAt, requiresTag, type-only patterns and deny roles', async () => {
    expect(
      await support([
        role('viewer', ['doc:read']),
        role('owner', [{ permission: 'doc:read', relation: 'owner' }]),
        role('me', [{ permission: 'doc:read', relation: ['self'] }]),
        role('pm', [{ permission: 'doc:read', grantedAt: ['project'] }]),
        role('paid', [{ permission: 'doc:read', requiresTag: 'paid' }]),
        role('typed', [{ permission: 'doc:read', on: [{ type: 'doc' }] }]),
        { ...role('blocked', ['doc:read']), deny: true },
      ]),
    ).to.equal(true);
  });

  it('refuses another relation', async () => {
    expect(await support([role('team', [{ permission: 'doc:read', relation: 'team' }])])).to.deep.equal({ reason: "rbac role 'team' grant 'doc:read' (source: test) has the relation 'team'; lists support owner and self only (assign a role on the resource instead), so doc:read on \"doc\" is not list-filterable" });
  });

  it('refuses on patterns with an id', async () => {
    expect(await support([role('one', [{ permission: 'doc:read', on: [{ type: 'doc', id: 'd1' }] }])])).to.deep.equal({ reason: "rbac role 'one' grant 'doc:read' (source: test) limits `on` by id; lists support type-only patterns, so doc:read on \"doc\" is not list-filterable" });
  });

  it('refuses requiresTag with grantedAt, and a relation with either', async () => {
    expect(((await support([role('x', [{ permission: 'doc:read', requiresTag: 't', grantedAt: ['project'] }])])) as { reason: string }).reason).to.contain('has both requiresTag and grantedAt');
    expect(((await support([role('x', [{ permission: 'doc:read', relation: 'owner', grantedAt: ['project'] }])])) as { reason: string }).reason).to.contain('joins a relation with requiresTag or grantedAt');
  });

  it('refuses a requiresTag an implied role also carries', async () => {
    const roles = [role('lead', [], { implies: [{ role: 'viewer', at: 'self-and-descendants', tags: ['paid'] }] }), role('viewer', []), role('paid', [{ permission: 'doc:read', requiresTag: 'paid' }])];
    expect(((await support(roles)) as { reason: string }).reason).to.contain("requires tag 'paid', which an implied role also carries");
  });

  it('refuses a config rule that can apply', async () => {
    const out = await support([role('viewer', ['doc:read'])], [{ id: 'strip', kind: 'cap', scope: GLOBAL, stripTags: true }]);
    expect((out as { reason: string }).reason).to.match(/^rbac rule 'strip' \(cap, source: .*\) can apply to it; lists cannot follow rules, so doc:read on "doc" is not list-filterable$/);
  });

  it('ruleCanMatch: restrict and cap match every permission of their types, a threshold its own permissions', () => {
    expect(ruleCanMatch({ kind: 'restrict' }, 'doc:read', 'doc')).to.equal(true);
    expect(ruleCanMatch({ kind: 'cap', resourceTypes: ['project'] }, 'doc:read', 'doc')).to.equal(false);
    expect(ruleCanMatch({ kind: 'threshold', permissions: ['doc:*'] }, 'doc:read', 'doc')).to.equal(true);
    expect(ruleCanMatch({ kind: 'threshold', permissions: ['doc:write'] }, 'doc:read', 'doc')).to.equal(false);
  });
});
