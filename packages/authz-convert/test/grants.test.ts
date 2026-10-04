import { PermissionRegistryImpl } from '@spinajs/authz';
import { compileGrants, compileRoles } from '@spinajs/authz-rbac';
import type { RoleDef } from '@spinajs/authz-rbac';
import { expect } from 'chai';

import { DEFAULT_SELF_RESOURCES, Findings, convertGrants } from '../src/index.js';
import type { Grant, GrantsResult } from '../src/index.js';

function run(rbac: Record<string, unknown>, selfResources = DEFAULT_SELF_RESOURCES): { r: GrantsResult; f: Findings } {
  const f = new Findings();
  const r = convertGrants(rbac, { selfResources }, f);
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
function compile3(r: GrantsResult, extra: string[] = []) {
  const registry = new PermissionRegistryImpl();
  registry.register(
    [...r.permissions].map(([name, d]) => ({ name, ...(d.fields ? { fields: true } : {}) })),
    'config',
  );
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

    it("turns ':own' on the caller's account into relation 'self'", () => {
      for (const res of ['user', 'users', 'UserBase']) {
        expect(grantsOf({ grants: { r: { [res]: { 'read:own': ['*'] } } } })).to.deep.equal([{ permission: `${res}:read`, relation: 'self' }]);
      }
    });

    it('takes the self resources it is given', () => {
      const { r } = run({ grants: { r: { Account: { 'read:own': ['*'] }, user: { 'read:own': ['*'] } } } }, ['Account']);
      expect(r.roles.get('r')!.grants).to.deep.equal([
        { permission: 'Account:read', relation: 'self' },
        { permission: 'user:read', relation: 'owner' },
      ]);
    });

    it('writes nothing for an action key without a possession, which 2.x never read', () => {
      const { r, f } = run({ grants: { r: { Doc: { read: ['*'] } } } });
      expect(r.roles.get('r')!.grants).to.deep.equal([]);
      expect(f.list.map((x) => [x.severity, x.code])).to.deep.include(['manual', 'action-without-possession']);
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

    it('refuses an attribute 3.0 cannot read as a field glob', () => {
      refused({ grants: { r: { Doc: { 'read:any': ['items[*].name'] } } } }, /not a 3.0 field glob/);
    });
  });

  describe('collapse', () => {
    it("writes 'X:*' when all four actions carry the same condition and no fields", () => {
      const rw = { 'create:own': ['scope:polsat'], 'read:own': ['scope:polsat'], 'update:own': ['scope:polsat'], 'delete:own': ['scope:polsat'] };
      expect(grantsOf({ grants: { r: { ArrowCampaign: rw, ArrowClient: { 'create:any': ['*'] } } } })).to.deep.equal([{ permission: 'ArrowCampaign:*', relation: 'polsat' }, 'ArrowClient:create']);
    });

    it('keeps the four actions apart when one differs', () => {
      const g = grantsOf({ grants: { r: { Doc: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:own': ['*'] } } } });
      expect(g).to.deep.equal(['Doc:create', 'Doc:read', 'Doc:update', { permission: 'Doc:delete', relation: 'owner' }]);
    });

    it('registers the four permissions a collapsed grant stands for', () => {
      const { r } = run({ grants: { r: { Doc: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] } } } });
      expect([...r.permissions.keys()]).to.deep.equal(['Doc:create', 'Doc:read', 'Doc:update', 'Doc:delete']);
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

    it('does not write a declared role that differs from a granted one only in case', () => {
      const { r, f } = run({ grants: { admin: {} }, roles: [{ Name: 'Admin', Description: 'Administrator' }] });
      expect([...r.roles.keys()]).to.deep.equal(['admin']);
      expect(f.list.find((x) => x.code === 'role-case')?.severity).to.equal('warning');
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

  describe('refusals', () => {
    it('refuses an action accesscontrol would refuse', () => {
      refused({ grants: { r: { Doc: { 'READ:any': ['*'] } } } }, /not a 2\.x action/);
      refused({ grants: { r: { Doc: { 'read:mine': ['*'] } } } }, /not a 2\.x action/);
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
          user: { $extend: ['base'], user: { 'read:own': ['*', '!Password'], 'update:own': ['Email'] }, 'user.metadata': { 'create:own': ['*'], 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] } },
          admin: { $extend: ['user'], users: { 'create:any': ['*'], 'read:any': ['*'], 'update:any': ['*'], 'delete:any': ['*'] } },
          'polsat.backoffice': { ArrowCampaign: { 'create:own': ['scope:polsat'], 'read:own': ['scope:polsat'], 'update:own': ['scope:polsat'], 'delete:own': ['scope:polsat'] } },
        },
        roles: [{ Name: 'Stock editor' }],
      });
      expect(f.problems).to.deep.equal([]);
      const index = compile3(r, ['base']);
      expect(index.permissions('admin')).to.include.members(['users:update', 'user:read', 'user.metadata:delete']);
      expect(index.grants('user', 'user:read')[0].relations).to.deep.equal(['self']);
      expect(index.grants('polsat.backoffice', 'ArrowCampaign:delete')[0].relations).to.deep.equal(['polsat']);
      expect(index.unmatchedGlobs).to.deep.equal([]);
      expect(index.droppedFields).to.deep.equal([]);
    });
  });
});
