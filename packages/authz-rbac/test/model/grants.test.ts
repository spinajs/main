import { AuthzConfigError, PermissionRegistryImpl, UnknownPermission, compilePermissionGlob } from '@spinajs/authz';
import type { PermissionInput } from '@spinajs/authz';
import { arb } from '@spinajs/authz-testing';
import * as chai from 'chai';
import * as fc from 'fast-check';
import 'mocha';

import { compileGrants, compileRoles } from '../../src/index.js';
import type { GrantDef, RoleDef } from '../../src/index.js';

const expect = chai.expect;

const registry = (defs: readonly (string | PermissionInput)[]): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    defs.map((d) => (typeof d === 'string' ? { name: d } : d)),
    'test',
  );
  r.freeze();
  return r;
};

type Extra = Partial<Omit<RoleDef, 'name' | 'grants'>>;
const role = (name: string, grants: readonly (string | GrantDef)[] = [], extra: Extra = {}): RoleDef => ({ name, extends: [], assignable: true, source: 'test', ...extra, grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)) });

const compile = (roles: readonly RoleDef[], reg: PermissionRegistryImpl) => compileGrants(compileRoles(roles), reg);

const thrown = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a throw');
};

const PERMS = ['file:read', 'file:write', 'file:delete', 'project:read', 'project:settings', 'user:read'];

describe('authz-rbac model: compileGrants', () => {
  describe('expansion', () => {
    it('a literal grant gives that permission', () => {
      const idx = compile([role('viewer', ['file:read'])], registry(PERMS));
      expect(idx.permissions('viewer')).to.deep.equal(['file:read']);
      const [g] = idx.grants('viewer', 'file:read');
      expect(g.role).to.equal('viewer');
      expect(g.permission).to.equal('file:read');
      expect(g.via).to.equal('direct');
      expect(g.impliedFrom).to.equal(undefined);
      expect(g.def).to.deep.equal({ permission: 'file:read' });
    });

    it('a glob gives every registered permission it matches', () => {
      const idx = compile([role('editor', ['file:*'])], registry(PERMS));
      expect(idx.permissions('editor')).to.deep.equal(['file:delete', 'file:read', 'file:write']);
      expect(idx.grants('editor', 'file:write')[0].def.permission).to.equal('file:*');
    });

    it("'*' gives every registered permission", () => {
      const idx = compile([role('root', ['*'])], registry(PERMS));
      expect(idx.permissions('root')).to.deep.equal([...PERMS].sort());
    });

    it('a glob with a star inside a part', () => {
      const idx = compile([role('r', ['*:read'])], registry(PERMS));
      expect(idx.permissions('r')).to.deep.equal(['file:read', 'project:read', 'user:read']);
    });

    it('implies is followed transitively and marked as implied', () => {
      const reg = registry([{ name: 'file:delete', implies: ['file:write'] }, { name: 'file:write', implies: ['file:read'] }, 'file:read']);
      const idx = compile([role('r', ['file:delete'])], reg);
      expect(idx.permissions('r')).to.deep.equal(['file:delete', 'file:read', 'file:write']);
      const [read] = idx.grants('r', 'file:read');
      expect(read.via).to.equal('implies');
      expect(read.impliedFrom).to.equal('file:delete');
      expect(read.role).to.equal('r');
      expect(read.def.permission).to.equal('file:delete');
    });

    it('a cycle in implies ends', () => {
      const reg = registry([
        { name: 'a:x', implies: ['b:x'] },
        { name: 'b:x', implies: ['a:x'] },
      ]);
      const idx = compile([role('r', ['a:x'])], reg);
      expect(idx.permissions('r')).to.deep.equal(['a:x', 'b:x']);
      expect(idx.grants('r', 'a:x')).to.have.length(1);
    });

    it('a permission matched directly is not repeated as implied by the same grant', () => {
      const reg = registry([{ name: 'file:write', implies: ['file:read'] }, 'file:read']);
      const idx = compile([role('r', ['file:*'])], reg);
      const reads = idx.grants('r', 'file:read');
      expect(reads).to.have.length(1);
      expect(reads[0].via).to.equal('direct');
    });

    it('an implied permission keeps relation, on, requiresTag and grantedAt of its grant', () => {
      const reg = registry([{ name: 'file:write', implies: ['file:read'] }, 'file:read']);
      const grant: GrantDef = { permission: 'file:write', relation: 'owner', on: [{ type: 'file', id: 'a*' }], requiresTag: 'beta', grantedAt: ['project'] };
      const [read] = compile([role('r', [grant])], reg).grants('r', 'file:read');
      expect(read.relations).to.deep.equal(['owner']);
      expect(read.on).to.deep.equal(grant.on);
      expect(read.requiresTag).to.equal('beta');
      expect(read.grantedAt).to.deep.equal(['project']);
    });

    it('relation is normalised to an array and left out when the grant has none', () => {
      const idx = compile([role('r', [{ permission: 'file:read', relation: ['owner', 'member'] }, { permission: 'file:write', relation: 'owner' }, 'file:delete'])], registry(PERMS));
      expect(idx.grants('r', 'file:read')[0].relations).to.deep.equal(['owner', 'member']);
      expect(idx.grants('r', 'file:write')[0].relations).to.deep.equal(['owner']);
      expect(idx.grants('r', 'file:delete')[0]).not.to.have.property('relations');
    });

    it('several grants of one role for one permission are all kept, in declaration order', () => {
      const idx = compile([role('r', [{ permission: 'file:read', relation: 'owner' }, 'file:*'])], registry(PERMS));
      expect(idx.grants('r', 'file:read').map((g) => g.def.permission)).to.deep.equal(['file:read', 'file:*']);
    });
  });

  describe('extends', () => {
    it("a role's permissions are the union over its extends closure, each grant keeping its declaring role", () => {
      const roles = [role('viewer', ['file:read']), role('editor', ['file:write'], { extends: ['viewer'] }), role('lead', [{ permission: 'file:read', relation: 'owner' }], { extends: ['editor'] })];
      const idx = compile(roles, registry(PERMS));
      expect(idx.permissions('editor')).to.deep.equal(['file:read', 'file:write']);
      expect(idx.permissions('viewer')).to.deep.equal(['file:read']);
      expect(idx.grants('editor', 'file:read').map((g) => g.role)).to.deep.equal(['viewer']);
      expect(idx.grants('lead', 'file:read').map((g) => g.role)).to.deep.equal(['lead', 'viewer']);
    });

    it('a non-assignable role still passes its grants on', () => {
      const idx = compile([role('pkg', ['user:read'], { assignable: false }), role('admin', [], { extends: ['pkg'] })], registry(PERMS));
      expect(idx.permissions('admin')).to.deep.equal(['user:read']);
    });
  });

  describe('lookups', () => {
    const idx = compile([role('viewer', ['file:read']), role('empty')], registry(PERMS));

    it('granted tells whether any role grants a permission', () => {
      expect(idx.granted('file:read')).to.equal(true);
      expect(idx.granted('file:write')).to.equal(false);
      expect(idx.granted('ghost:read')).to.equal(false);
    });

    it('unknown roles and ungranted permissions give empty lists', () => {
      expect(idx.grants('viewer', 'file:write')).to.deep.equal([]);
      expect(idx.grants('ghost', 'file:read')).to.deep.equal([]);
      expect(idx.permissions('ghost')).to.deep.equal([]);
      expect(idx.permissions('empty')).to.deep.equal([]);
    });

    it('is immutable', () => {
      expect(Object.isFrozen(idx)).to.equal(true);
      expect(Object.isFrozen(idx.permissions('viewer'))).to.equal(true);
      expect(Object.isFrozen(idx.grants('viewer', 'file:read'))).to.equal(true);
      expect(Object.isFrozen(idx.grants('viewer', 'file:read')[0])).to.equal(true);
      expect(Object.isFrozen(idx.grants('viewer', 'file:write'))).to.equal(true);
    });
  });

  describe('fields', () => {
    const reg = registry([{ name: 'user:update', fields: true, implies: ['user:read', 'user:stat'] }, { name: 'user:read', fields: true }, 'user:stat', 'user:delete']);
    const fields = { read: ['Login'] };

    it('a grant carries its fields on a permission with fields: true', () => {
      const idx = compile([role('r', [{ permission: 'user:read', fields }])], reg);
      expect(idx.grants('r', 'user:read')[0].fields).to.deep.equal(fields);
    });

    it('an implied permission gets the fields only when it has fields: true', () => {
      const idx = compile([role('r', [{ permission: 'user:update', fields }])], reg);
      expect(idx.grants('r', 'user:read')[0].fields).to.deep.equal(fields);
      expect(idx.grants('r', 'user:stat')[0]).not.to.have.property('fields');
    });

    it('a literal grant with fields on a permission without fields: true is refused', () => {
      const err = thrown(() => compile([role('r', [{ permission: 'user:delete', fields }])], reg));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err.message).to.contain("'r'").and.to.contain('user:delete').and.to.contain('fields');
    });

    it('a glob grant with fields drops them on the matched permissions without fields: true', () => {
      const idx = compile([role('r', [{ permission: 'user:*', fields }])], reg);
      expect(idx.grants('r', 'user:read')[0].fields).to.deep.equal(fields);
      expect(idx.grants('r', 'user:delete')[0]).not.to.have.property('fields');
      expect(idx.droppedFields).to.deep.equal([]);
    });

    it('a glob grant with fields that reach no permission is listed in droppedFields', () => {
      const idx = compile([role('r', [{ permission: 'user:del*', fields }, { permission: 'user:up*', fields }, 'user:*'])], reg);
      expect(idx.droppedFields).to.deep.equal([{ role: 'r', glob: 'user:del*' }]);
      expect(Object.isFrozen(idx.droppedFields)).to.equal(true);
    });
  });

  describe('refusals', () => {
    it('a literal unregistered permission is UnknownPermission naming it and the role (B02)', () => {
      const err = thrown(() => compile([role('editor', ['file:read', 'ghost:read'])], registry(['file:read'])));
      expect(err).to.be.instanceOf(UnknownPermission);
      expect(err.message).to.contain('ghost:read').and.to.contain("'editor'");
    });

    it('an unregistered permission inherited through extends names the declaring role', () => {
      const err = thrown(() => compile([role('base', ['ghost:read']), role('top', [], { extends: ['base'] })], registry(['file:read'])));
      expect(err).to.be.instanceOf(UnknownPermission);
      expect(err.message).to.contain("'base'");
    });

    it('an invalid glob is AuthzConfigError with the core message and the role', () => {
      const core = thrown(() => compilePermissionGlob('file:**')).message;
      const err = thrown(() => compile([role('r', ['file:**'])], registry(PERMS)));
      expect(err).to.be.instanceOf(AuthzConfigError);
      expect(err).not.to.be.instanceOf(UnknownPermission);
      expect(err.message).to.contain(core).and.to.contain("'r'");
    });

    it('an invalid name is AuthzConfigError', () => {
      for (const bad of ['file', 'file:', ':read', '1file:read', '']) {
        const err = thrown(() => compile([role('r', [bad])], registry(PERMS)));
        expect(err, bad).to.be.instanceOf(AuthzConfigError);
        expect(err, bad).not.to.be.instanceOf(UnknownPermission);
      }
    });

    it('a malformed grant is AuthzConfigError', () => {
      for (const bad of [null, 'file:read', { relation: 'owner' }, { permission: 'file:read', relation: [] }, { permission: 'file:read', relation: [1] }]) {
        const err = thrown(() => compile([{ ...role('r'), grants: [bad] as unknown as GrantDef[] }], registry(PERMS)));
        expect(err, JSON.stringify(bad)).to.be.instanceOf(AuthzConfigError);
        expect(err.message).to.contain("'r'");
      }
    });

    it('on that is empty, not an array or holds a malformed pattern is AuthzConfigError naming the grant', () => {
      for (const on of [[], 'file', [{ type: '' }], [{ type: 'file', id: '{principal}' }]]) {
        const err = thrown(() => compile([role('r', [{ permission: 'file:*', on } as unknown as GrantDef])], registry(PERMS)));
        expect(err, JSON.stringify(on)).to.be.instanceOf(AuthzConfigError);
        expect(err.message).to.contain("rbac role 'r' grant 'file:*' (source: test)");
      }
    });

    it('on is compiled once per grant and shared by its expanded permissions', () => {
      const reg = registry([{ name: 'file:write', implies: ['file:read'] }, 'file:read']);
      const idx = compile([role('r', [{ permission: 'file:write', on: [{ type: 'file', id: 'a/{principal.id}/*' }] }, 'file:read'])], reg);
      const [write] = idx.grants('r', 'file:write');
      const [read, plain] = idx.grants('r', 'file:read');
      expect(write.patterns).to.deep.equal([{ type: 'file', id: ['a/', { principal: ['id'] }, '/*'], glob: true, pattern: { type: 'file', id: 'a/{principal.id}/*' } }]);
      expect(read.patterns).to.equal(write.patterns);
      expect(Object.isFrozen(write.patterns![0])).to.equal(true);
      expect(plain).not.to.have.property('patterns');
    });

    it('an implied permission the registry does not hold is UnknownPermission (unfrozen registry)', () => {
      const reg = new PermissionRegistryImpl();
      reg.register([{ name: 'file:write', implies: ['file:ghost'] }], 'test');
      const err = thrown(() => compileGrants(compileRoles([role('r', ['file:write'])]), reg));
      expect(err).to.be.instanceOf(UnknownPermission);
      expect(err.message).to.contain('file:ghost').and.to.contain('file:write');
    });
  });

  describe('globs that match nothing', () => {
    it('are accepted and reported', () => {
      const idx = compile([role('r', ['billing:*', 'file:read'])], registry(PERMS));
      expect(idx.permissions('r')).to.deep.equal(['file:read']);
      expect(idx.unmatchedGlobs).to.deep.equal([{ role: 'r', glob: 'billing:*' }]);
    });
  });

  describe('determinism and properties', () => {
    const POOL = ['file:read', 'file:write', 'file:delete', 'project:read', 'project:write', 'user.tokens:read', 'user:read'];

    // Registry definitions with random implies (cycles included) over POOL.
    const registryDefs = fc.tuple(fc.shuffledSubarray(POOL, { minLength: POOL.length, maxLength: POOL.length }), fc.array(fc.tuple(fc.constantFrom(...POOL), fc.constantFrom(...POOL)), { maxLength: 8 })).map(([names, edges]) => names.map((name) => ({ name, implies: [...new Set(edges.filter(([from]) => from === name).map(([, to]) => to))] })));

    const grantList = fc.array(fc.oneof(arb.permissionName({ pool: POOL }), arb.permissionGlob({ pool: POOL })), { maxLength: 4 });

    it('a role grants exactly the registered permissions some grant in its closure matches, closed under implies', () => {
      fc.assert(
        fc.property(registryDefs, grantList, grantList, (defs, own, inherited) => {
          const reg = registry(defs);
          const idx = compile([role('base', inherited), role('top', own, { extends: ['base'] })], reg);
          const expected = new Set<string>();
          for (const g of [...own, ...inherited]) for (const p of POOL) if (compilePermissionGlob(g)(p)) expected.add(p);
          const todo = [...expected];
          while (todo.length) for (const next of reg.get(todo.pop()!)?.implies ?? []) if (!expected.has(next)) expected.add(next), todo.push(next);
          expect(idx.permissions('top')).to.deep.equal([...expected].sort());
          for (const p of expected) expect(idx.granted(p)).to.equal(true);
        }),
      );
    });

    it('the registration order of permissions does not change the index', () => {
      fc.assert(
        fc.property(registryDefs, grantList, (defs, grants) => {
          const a = compile([role('r', grants)], registry(defs));
          const b = compile([role('r', grants)], registry([...defs].reverse()));
          expect(b.permissions('r')).to.deep.equal(a.permissions('r'));
          for (const p of a.permissions('r')) expect(b.grants('r', p)).to.deep.equal(a.grants('r', p));
        }),
      );
    });
  });
});
