import { PermissionRegistryImpl } from '@spinajs/authz';
import { compileGrants, compileRoles } from '@spinajs/authz-rbac';
import type { RoleDef } from '@spinajs/authz-rbac';
import { expect } from 'chai';

import { DEFAULT_SELF_RESOURCES, Findings, convertGrants } from '../src/index.js';
import type { Grant, GrantsResult } from '../src/index.js';

function run(rbac: Record<string, unknown>, selfResources = DEFAULT_SELF_RESOURCES, granted?: Set<string>): { r: GrantsResult; f: Findings } {
  const f = new Findings();
  const r = convertGrants(rbac, { selfResources }, f, granted ? { granted } : undefined);
  return { r, f };
}

const grantsOf = (rbac: Record<string, unknown>, role = 'r'): Grant[] => {
  const { r, f } = run(rbac);
  expect(f.problems).to.deep.equal([]);
  return r.roles.get(role)!.grants;
};

function refused(rbac: Record<string, unknown>, pattern: RegExp): void {
  const { f } = run(rbac);
  expect(f.problems.some((p) => pattern.test(p)), f.problems.join('\n')).to.equal(true);
}

/** Compiles the output with the 3.0 RBAC compiler, the way ConfigRoleStore hands it over. */
function compile3(r: GrantsResult, extra: string[] = [], packagePermissions: string[] = []) {
  const registry = new PermissionRegistryImpl();
  registry.register(
    [...r.permissions].map(([name, d]) => ({ name, ...(d.fields ? { fields: true } : {}) })),
    'config',
  );
  if (packagePermissions.length > 0) registry.register(packagePermissions.map((name) => ({ name })), 'package');
  registry.freeze();
  const defs: RoleDef[] = [...r.roles].map(([name, role]) => ({
    name,
    extends: role.extends ?? [],
    grants: role.grants.map((g) => (typeof g === 'string' ? { permission: g } : g)),
    assignable: role.assignable ?? true,
    source: 'config',
  }));
  for (const name of extra) defs.push({ name, extends: [], grants: [], assignable: true, source: 'test' });
  const graph = compileRoles(defs);
  return compileGrants(graph, registry);
}

describe('convertGrants', () => {
  describe('possession', () => {
    it("turns ':any' with every attribute into a plain grant", () => {
      expect(grantsOf({ grants: { r: { Doc: { 'read:any': ['*'] } } } })).to.deep.equal(['Doc:read']);
    });

    it("turns ':own' into relation 'owner'", () => {
      expect(grantsOf({ grants: { r: { Doc: { 'update:own': ['*'] } } } })).to.deep.equal([{ permission: 'Doc:update', relation: 'owner' }]);
    });

    it("turns ':own' on the caller's account into relation 'self', with a warning", () => {
      const { r, f } = run({ grants: { r: { user: { 'read:own': ['*'] } } } });
      expect(r.roles.get('r')!.grants).to.deep.equal([{ permission: 'user:read', relation: 'self' }]);
      expect(f.list.find((x) => x.code === 'self-relation')?.severity).to.equal('warning');
    });

    it("keeps relation 'owner' on model resources such as users, whose :own ran the app's default policy", () => {
      const g = grantsOf({ grants: { 'users.self': { users: { 'read:own': ['*'], 'update:own': ['*'] }, UserBase: { 'read:own': ['*'] } } } }, 'users.self');
      expect(g).to.deep.equal([
        { permission: 'users:read', relation: 'owner' },
        { permission: 'users:update', relation: 'owner' },
        { permission: 'UserBase:read', relation: 'owner' },
      ]);
    });

    it('takes the self resources it is given', () => {
      const { r } = run({ grants: { r: { Account: { 'read:own': ['*'] }, user: { 'read:own': ['*'] } } } }, ['Account']);
      expect(r.roles.get('r')!.grants).to.deep.equal([
        { permission: 'Account:read', relation: 'self' },
        { permission: 'user:read', relation: 'owner' },
      ]);
    });

    it('writes nothing for action keys 2.x accepted but never read', () => {
      const { r, f } = run({ grants: { r: { Doc: { read: ['*'], 'update:': ['*'], 'delete:any:x': ['*'] } } } });
      expect(f.problems).to.deep.equal([]);
      expect(r.roles.get('r')!.grants).to.deep.equal([]);
      expect(f.list.filter((x) => x.severity === 'manual' && x.code === 'action-never-read')).to.have.length(3);
    });

    it('writes nothing for an empty or all-negated attribute list, which granted nothing in 2.x', () => {
      const { r, f } = run({ grants: { r: { Doc: { 'read:any': [], 'update:own': ['!Password'] } } } });
      expect(r.roles.get('r')!.grants).to.deep.equal([]);
      expect(f.list.filter((x) => x.code === 'grants-nothing')).to.have.length(2);
    });

    it('drops an :own grant that adds nothing to the :any grant beside it', () => {
      const { r, f } = run({ grants: { r: { Doc: { 'read:any': ['*'], 'read:own': ['*'] } } } });
      expect(r.roles.get('r')!.grants).to.deep.equal(['Doc:read']);
      expect(f.list.map((x) => x.code)).to.include('own-under-any');
    });

    it('keeps both grants and warns when :any and :own carry different attributes', () => {
      const { r, f } = run({ grants: { r: { Doc: { 'read:any': ['Title'], 'read:own': ['*'] } } } });
      expect(r.roles.get('r')!.grants).to.deep.equal([{ permission: 'Doc:read', fields: { read: ['Title'] } }, { permission: 'Doc:read', relation: 'owner' }]);
      expect(f.list.find((x) => x.code === 'own-any-fields')?.severity).to.equal('warning');
    });
  });

  describe('scope tokens', () => {
    it('turns a scope token into a relation of the same name', () => {
      expect(grantsOf({ grants: { r: { Campaign: { 'read:own': ['scope:polsat'] } } } })).to.deep.equal([{ permission: 'Campaign:read', relation: 'polsat' }]);
    });

    it('turns several tokens into several relations, which 3.0 ORs as 2.x did', () => {
      expect(grantsOf({ grants: { r: { Campaign: { 'read:own': ['scope:a', 'scope:b', 'scope:a'] } } } })).to.deep.equal([{ permission: 'Campaign:read', relation: ['a', 'b'] }]);
    });

    it("reads 'scope:default' as the default owner scope", () => {
      expect(grantsOf({ grants: { r: { Campaign: { 'read:own': ['scope:default', 'scope:pool'] } } } })).to.deep.equal([{ permission: 'Campaign:read', relation: ['owner', 'pool'] }]);
    });

    it('keeps the other attributes of a scoped grant as fields', () => {
      expect(grantsOf({ grants: { r: { Campaign: { 'read:own': ['scope:pool', 'Name', 'Budget'] } } } })).to.deep.equal([
        { permission: 'Campaign:read', relation: 'pool', fields: { read: ['Name', 'Budget'] } },
      ]);
    });

    it('refuses a scope token on an :any grant, which 2.x ignored', () => {
      refused({ grants: { r: { Campaign: { 'read:any': ['scope:pool'] } } } }, /scope token on an :any grant/);
    });

    it('refuses scope tokens next to negations only', () => {
      refused({ grants: { r: { Campaign: { 'read:own': ['scope:pool', '!Secret'] } } } }, /negated attributes only/);
    });

    it('refuses a token that names no valid relation', () => {
      refused({ grants: { r: { Campaign: { 'read:own': ['scope:'] } } } }, /does not name a valid relation/);
    });

    it("refuses tokens 'owner' and 'self', which would merge an app policy into a 3.0 relation", () => {
      refused({ grants: { r: { Campaign: { 'read:own': ['scope:owner'] } } } }, /would merge an app policy/);
      refused({ grants: { r: { Campaign: { 'read:own': ['scope:self'] } } } }, /would merge an app policy/);
    });

    it('refuses attributes with spaces around them, which 2.x and 3.0 read differently', () => {
      refused({ grants: { r: { Campaign: { 'read:own': [' scope:pool'] } } } }, /carry spaces/);
    });
  });

  describe('fields', () => {
    it('puts read attributes into fields.read and create/update attributes into fields.write', () => {
      const { r } = run({ grants: { r: { user: { 'read:any': ['*', '!Password'], 'update:any': ['Email', 'Login'], 'create:any': ['Email'] } } } });
      expect(r.roles.get('r')!.grants).to.deep.equal([
        { permission: 'user:create', fields: { write: ['Email'] } },
        { permission: 'user:read', fields: { read: ['*', '!Password'] } },
        { permission: 'user:update', fields: { write: ['Email', 'Login'] } },
      ]);
      expect([...r.permissions]).to.deep.equal([
        ['user:create', { fields: true }],
        ['user:read', { fields: true }],
        ['user:update', { fields: true }],
      ]);
    });

    it('gives a delete grant no fields and says why', () => {
      const { r, f } = run({ grants: { r: { Doc: { 'delete:any': ['Title'] } } } });
      expect(r.roles.get('r')!.grants).to.deep.equal(['Doc:delete']);
      expect(f.list.map((x) => x.code)).to.include('delete-fields');
    });

    it('compares field lists by meaning, not by spelling', () => {
      expect(grantsOf({ grants: { r: { Doc: { 'read:any': ['*', 'Title'] } } } })).to.deep.equal(['Doc:read']);
      const { f } = run({ grants: { r: { Doc: { 'read:any': ['A', 'B'], 'read:own': ['B', 'A'] } } } });
      expect(f.list.map((x) => x.code)).to.include('own-under-any');
    });

    it('refuses an attribute 3.0 cannot read as a field glob', () => {
      refused({ grants: { r: { Doc: { 'read:any': ['items[*].name'] } } } }, /not a 3.0 field glob/);
    });
  });

  describe('actions', () => {
    it('writes each 2.x action as its own permission and never the glob X:*', () => {
      const rw = { 'create:own': ['scope:polsat'], 'read:own': ['scope:polsat'], 'update:own': ['scope:polsat'], 'delete:own': ['scope:polsat'] };
      expect(grantsOf({ grants: { r: { ArrowCampaign: rw, ArrowClient: { 'create:any': ['*'] } } } })).to.deep.equal([
        { permission: 'ArrowCampaign:create', relation: 'polsat' },
        { permission: 'ArrowCampaign:read', relation: 'polsat' },
        { permission: 'ArrowCampaign:update', relation: 'polsat' },
        { permission: 'ArrowCampaign:delete', relation: 'polsat' },
        'ArrowClient:create',
      ]);
    });

    it("turns the 2.x impersonation grant into permission 'user:impersonate'", () => {
      const { r, f } = run({ grants: { admin: { 'user:impersonate': { 'create:any': ['*'] } } } });
      expect(f.problems).to.deep.equal([]);
      expect(r.roles.get('admin')!.grants).to.deep.equal(['user:impersonate']);
      expect([...r.permissions]).to.deep.equal([['user:impersonate', { fields: false }]]);
    });

    it('writes nothing for impersonation actions 2.x never asked, and refuses a scope token there', () => {
      const { r, f } = run({ grants: { admin: { 'user:impersonate': { 'create:own': ['*'], 'read:any': ['*'] } } } });
      expect(r.roles.get('admin')!.grants).to.deep.equal([]);
      expect(f.list.filter((x) => x.code === 'impersonate-action')).to.have.length(2);
      refused({ grants: { admin: { 'user:impersonate': { 'create:any': ['scope:pool'] } } } }, /scope token on an :any grant/);
    });
  });

  describe('roles', () => {
    it("turns '$extend' into 'extends' without repeats", () => {
      const { r } = run({ grants: { r: { $extend: ['a', 'b', 'a'] }, a: {}, b: {} } });
      expect(r.roles.get('r')).to.deep.equal({ extends: ['a', 'b'], grants: [] });
    });

    it('attaches a declared description to the granted role of the same name', () => {
      const { r } = run({ grants: { admin: {} }, roles: [{ Name: 'admin', Description: 'Administrator' }] });
      expect(r.roles.get('admin')).to.deep.equal({ grants: [], description: 'Administrator' });
    });

    it('does not write a declared role that differs from a granted one only in case, and says what changes', () => {
      const { r, f } = run({ grants: { admin: {} }, roles: [{ Name: 'Admin', Description: 'Administrator' }] });
      expect([...r.roles.keys()]).to.deep.equal(['admin']);
      const w = f.list.find((x) => x.code === 'role-case')!;
      expect(w.severity).to.equal('warning');
      expect(w.message).to.match(/2\.x .* no permission at all.*3\.0 .* other roles apply/);
    });

    it('checks declared roles against the roles other layers grant', () => {
      const { r, f } = run({ roles: [{ Name: 'admin', Description: 'Administrator' }, { Name: 'Editor' }] }, DEFAULT_SELF_RESOURCES, new Set(['admin', 'editor']));
      expect(r.roles.get('admin')).to.deep.equal({ description: 'Administrator', grants: [] });
      expect(r.roles.has('Editor')).to.equal(false);
      expect(f.list.map((x) => x.code)).to.deep.equal(['role-case']);
    });

    it('keeps two declared-only roles that differ in case', () => {
      const { r } = run({ roles: [{ Name: 'Editor' }, { Name: 'editor' }] });
      expect([...r.roles.keys()]).to.deep.equal(['Editor', 'editor']);
    });

    it('writes a declared role without grants so its assignments stay valid', () => {
      const { r, f } = run({ grants: {}, roles: [{ Name: 'Stock editor', Description: 'Editor' }] });
      expect(r.roles.get('Stock editor')).to.deep.equal({ description: 'Editor', grants: [] });
      expect(f.list.map((x) => x.code)).to.include('declared-without-grants');
    });

    it('warns about granted roles that differ only in case and keeps both', () => {
      const { r, f } = run({ grants: { Editor: {}, editor: {} } });
      expect([...r.roles.keys()]).to.deep.equal(['Editor', 'editor']);
      expect(f.list.map((x) => x.code)).to.include('role-case');
    });

    it('keeps names verbatim (H17)', () => {
      const { r } = run({ grants: { 'polsat.backoffice': { ArrowV1CampaignView: { 'read:any': ['*'] } } } });
      expect(r.roles.get('polsat.backoffice')!.grants).to.deep.equal(['ArrowV1CampaignView:read']);
    });
  });

  describe('2.x package grants', () => {
    it('refuses a negation or scope token on a key a 2.x package also granted, which 2.x joined with the package list', () => {
      refused({ grants: { 'admin.users': { users: { 'read:any': ['*', '!Salary'] } } } }, /a 2\.x package grants the same key/);
      refused({ grants: { user: { 'user.metadata': { 'read:own': ['scope:pool'] } } } }, /a 2\.x package grants the same key/);
      refused({ grants: { user: { user: { 'update:own': ['*', '!Password'] } } } }, /a 2\.x package grants the same key/);
    });

    it('keeps a plain list or a negation of a field the package never gave, which is the same union in 3.0', () => {
      const { r, f } = run({ grants: { user: { user: { 'read:own': ['*', '!Password'] } }, 'admin.users': { users: { 'read:any': ['Name'] } } } });
      expect(f.problems).to.deep.equal([]);
      expect(r.roles.get('admin.users')!.grants).to.deep.equal([{ permission: 'users:read', fields: { read: ['Name'] } }]);
      expect(f.list.filter((x) => x.code === 'package-grant')).to.have.length(2);
    });
  });

  describe('refusals', () => {
    it('refuses an action accesscontrol would refuse', () => {
      refused({ grants: { r: { Doc: { 'READ:any': ['*'] } } } }, /not a 2\.x action/);
      refused({ grants: { r: { Doc: { 'read:mine': ['*'] } } } }, /not a 2\.x action/);
      refused({ grants: { r: { Doc: { 'read:Any': ['*'] } } } }, /not a 2\.x action/);
      refused({ grants: { r: { Doc: { 'approve:any': ['*'] } } } }, /not a 2\.x action/);
    });

    it('refuses a resource that is not a valid 3.0 permission resource', () => {
      refused({ grants: { r: { 'my resource': { 'read:any': ['*'] } } } }, /not a valid 3\.0 permission resource/);
      refused({ grants: { r: { '1st': { 'read:any': ['*'] } } } }, /not a valid 3\.0 permission resource/);
    });

    it('refuses malformed attribute lists and role values', () => {
      refused({ grants: { r: { Doc: { 'read:any': '*' } } } }, /array of non-empty strings/);
      refused({ grants: { r: { Doc: { 'read:any': [1] } } } }, /array of non-empty strings/);
      refused({ grants: { r: [] } }, /must be an object/);
      refused({ grants: { r: { $extend: 'a' } } }, /array of role names/);
      refused({ grants: { r: { $extend: ['r'] } } }, /extends itself/);
      refused({ roles: { Name: 'x' } }, /rbac\.roles must be an array/);
      refused({ roles: [{ Description: 'x' }] }, /non-empty Name/);
    });

    it('collects every problem instead of stopping at the first', () => {
      const { f } = run({ grants: { r: { Doc: { 'READ:any': ['*'] }, 'bad name': { 'read:any': ['*'] } } } });
      expect(f.problems).to.have.length(2);
    });
  });

  describe('3.0 compile', () => {
    it('produces roles and permissions the 3.0 RBAC compiler accepts', () => {
      const { r, f } = run({
        grants: {
          user: { $extend: ['base'], user: { 'read:own': ['*', '!Secret'], 'update:own': ['Email'] }, 'user.metadata': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] } },
          admin: { $extend: ['user'], users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] } },
          root: { user: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] } },
          'polsat.backoffice': { ArrowCampaign: { 'create:own': ['scope:polsat'], 'read:own': ['scope:polsat'], 'update:own': ['scope:polsat'], 'delete:own': ['scope:polsat'] } },
        },
        roles: [{ Name: 'Stock editor' }],
      });
      expect(f.problems).to.deep.equal([]);
      const index = compile3(r, ['base'], ['user:impersonate']);
      expect(index.permissions('root')).to.deep.equal(['user:create', 'user:delete', 'user:read', 'user:update']);
      expect(index.permissions('admin')).to.include.members(['users:update', 'user:read', 'user.metadata:delete']);
      expect(index.grants('user', 'user:read')[0].relations).to.deep.equal(['self']);
      expect(index.grants('polsat.backoffice', 'ArrowCampaign:delete')[0].relations).to.deep.equal(['polsat']);
      expect(index.unmatchedGlobs).to.deep.equal([]);
      expect(index.droppedFields).to.deep.equal([]);
    });
  });
});
