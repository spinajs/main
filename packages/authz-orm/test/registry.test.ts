import * as chai from 'chai';
import 'mocha';

import { AuthzConfigError } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { ModelBase } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';

import { AccessResource, OrmScope, OrmScopePolicy, Owner, ScopeColumn, registerAccessResource } from '../src/index.js';
import { classesOf, entryOf, isRegistered, permissionFor, registeredTypes, scopePolicyOf, scopeRelationsOf, unregisterResource } from '../src/registry.js';

const expect = chai.expect;

class NoScope extends OrmScopePolicy {
  scope(_q: IWhereBuilder<ModelBase>, _p: Principal, _op: 'read' | 'update' | 'delete'): void {}
}

describe('authz-orm registry and decorators', () => {
  const made: Function[] = [];
  const track = <T extends Function>(c: T): T => {
    made.push(c);
    return c;
  };

  afterEach(() => {
    for (const c of made.splice(0)) unregisterResource(c);
  });

  it('@AccessResource registers the class with default permissions', () => {
    @AccessResource('reg-task')
    class Task extends ModelBase {}
    track(Task);

    const e = entryOf(Task)!;
    expect(e.type).to.equal('reg-task');
    expect(e.relationScope).to.equal('where');
    expect(e.permissions).to.deep.equal({ read: 'reg-task:read', create: 'reg-task:create', update: 'reg-task:update', delete: 'reg-task:delete' });
    expect(e.attributes).to.deep.equal([]);
    expect(e.scopeColumns).to.deep.equal([]);
    expect(e.owner).to.equal(undefined);
    expect(isRegistered(Task)).to.equal(true);
    expect(registeredTypes()).to.include('reg-task');
  });

  it('custom permissions, relationScope and attributes', () => {
    @AccessResource('reg-org', { relationScope: 'join', permissions: { read: 'org:view', delete: 'org:remove' }, attributes: ['policies'] })
    class Org extends ModelBase {}
    track(Org);

    const e = entryOf(Org)!;
    expect(e.relationScope).to.equal('join');
    expect(e.permissions).to.deep.equal({ read: 'org:view', create: 'reg-org:create', update: 'reg-org:update', delete: 'org:remove' });
    expect(e.attributes).to.deep.equal(['policies']);
    expect(permissionFor(Org, 'read')).to.equal('org:view');
    expect(permissionFor(Org, 'create')).to.equal('reg-org:create');
  });

  it('@Owner and @ScopeColumn in declaration order, nearest ancestor first', () => {
    @AccessResource('reg-file')
    class File extends ModelBase {
      @Owner()
      public owner_id!: string;

      @ScopeColumn('project_id', 'project')
      public ProjectId!: string;

      @ScopeColumn('org_id', 'org')
      public OrgId!: string;
    }
    track(File);

    const e = entryOf(File)!;
    expect(e.owner).to.equal('owner_id');
    expect(e.scopeColumns).to.deep.equal([
      { property: 'ProjectId', column: 'project_id', scopeType: 'project' },
      { property: 'OrgId', column: 'org_id', scopeType: 'org' },
    ]);
  });

  it('a second @Owner throws', () => {
    expect(() => {
      class Twice extends ModelBase {
        @Owner()
        public a!: string;

        @Owner()
        public b!: string;
      }
      return Twice;
    }).to.throw(AuthzConfigError, /one owner property/);
  });

  it('several classes share a type, in registration order (B21)', () => {
    @AccessResource('reg-shared')
    class A extends ModelBase {}
    @AccessResource('reg-shared')
    class B extends ModelBase {}
    track(A);
    track(B);

    expect(classesOf('reg-shared')).to.deep.equal([A, B]);
    expect(registeredTypes().filter((t) => t === 'reg-shared')).to.have.length(1);
  });

  it('a subclass resolves to its nearest registered ancestor and inherits its decorated properties', () => {
    @AccessResource('reg-base')
    class Base extends ModelBase {
      @Owner()
      public owner!: string;

      @ScopeColumn('org_id', 'org')
      public org_id!: string;
    }
    class Child extends Base {
      @ScopeColumn('team_id', 'team')
      public team_id!: string;
    }
    @AccessResource('reg-grandchild')
    class GrandChild extends Child {}
    track(Base);
    track(GrandChild);

    const child = entryOf(Child)!;
    expect(child.registered).to.equal(Base);
    expect(child.type).to.equal('reg-base');
    expect(child.owner).to.equal('owner');
    expect(child.scopeColumns.map((s) => s.column)).to.deep.equal(['org_id', 'team_id']);
    expect(entryOf(GrandChild)!.type).to.equal('reg-grandchild');
    expect(entryOf(ModelBase)).to.equal(undefined);
    expect(entryOf(undefined)).to.equal(undefined);
  });

  it('registerAccessResource registers a class it does not decorate', () => {
    class Job extends ModelBase {}
    track(Job);
    registerAccessResource(Job as never, 'reg-job', { attributes: [] });

    expect(entryOf(Job)!.type).to.equal('reg-job');
  });

  it('registering again with the same options is a no-op; other options throw', () => {
    class Cfg extends ModelBase {}
    track(Cfg);
    registerAccessResource(Cfg as never, 'reg-cfg', { relationScope: 'where' });
    registerAccessResource(Cfg as never, 'reg-cfg');
    expect(classesOf('reg-cfg')).to.deep.equal([Cfg]);

    expect(() => registerAccessResource(Cfg as never, 'reg-other')).to.throw(AuthzConfigError, /already registered/);
    expect(() => registerAccessResource(Cfg as never, 'reg-cfg', { relationScope: 'join' })).to.throw(AuthzConfigError, /already registered/);
  });

  it('@OrmScope maps (model, relation) to the policy class, found through subclasses', () => {
    @AccessResource('reg-scoped')
    class Scoped extends ModelBase {}
    class ScopedChild extends Scoped {}
    track(Scoped);

    @OrmScope(Scoped as never, 'pool')
    class PoolPolicy extends NoScope {}

    expect(scopePolicyOf(Scoped, 'pool')).to.equal(PoolPolicy);
    expect(scopePolicyOf(ScopedChild, 'pool')).to.equal(PoolPolicy);
    expect(scopePolicyOf(Scoped, 'other')).to.equal(undefined);
    expect(scopeRelationsOf(ScopedChild)).to.deep.equal(['pool']);

    expect(() => {
      @OrmScope(Scoped as never, 'pool')
      class Another extends NoScope {}
      return Another;
    }).to.throw(AuthzConfigError, /already the policy/);
  });

  it('@OrmScope needs an OrmScopePolicy subclass', () => {
    class M extends ModelBase {}
    track(M);
    expect(() => {
      @OrmScope(M as never, 'pool')
      class NotAPolicy {}
      return NotAPolicy;
    }).to.throw(AuthzConfigError, /must extend OrmScopePolicy/);
  });

  it('unregister keeps decorator metadata, so the class can register again', () => {
    class Again extends ModelBase {
      @Owner()
      public owner!: string;

      @ScopeColumn('org_id', 'org')
      public org_id!: string;
    }
    track(Again);
    registerAccessResource(Again as never, 'reg-again');
    unregisterResource(Again);
    expect(isRegistered(Again)).to.equal(false);
    registerAccessResource(Again as never, 'reg-again');

    const e = entryOf(Again)!;
    expect(e.owner).to.equal('owner');
    expect(e.scopeColumns.map((s) => s.column)).to.deep.equal(['org_id']);
  });

  it('a subclass overrides an inherited @Owner and a redeclared @ScopeColumn', () => {
    @AccessResource('reg-parent')
    class Parent extends ModelBase {
      @Owner()
      public creator!: string;

      @ScopeColumn('org_id', 'org')
      public scope!: string;
    }
    class Kid extends Parent {
      @Owner()
      public assignee!: string;

      @ScopeColumn('tenant_id', 'tenant')
      public scope!: string;
    }
    track(Parent);

    const e = entryOf(Kid)!;
    expect(e.owner).to.equal('assignee');
    expect(e.scopeColumns).to.deep.equal([{ property: 'scope', column: 'tenant_id', scopeType: 'tenant' }]);
    expect(entryOf(Parent)!.owner).to.equal('creator');
  });

  it('registeredTypes lists each type once, in first-registration order', () => {
    class T1 extends ModelBase {}
    class T2 extends ModelBase {}
    class T3 extends ModelBase {}
    for (const [c, t] of [
      [T1, 'reg-order-b'],
      [T2, 'reg-order-a'],
      [T3, 'reg-order-b'],
    ] as const) {
      track(c);
      registerAccessResource(c as never, t);
    }
    expect(registeredTypes().filter((t) => t.startsWith('reg-order-'))).to.deep.equal(['reg-order-b', 'reg-order-a']);
  });

  it('a symbol property cannot be the owner', () => {
    const key = Symbol('owner');
    expect(() => Owner()(ModelBase.prototype, key)).to.throw(AuthzConfigError, /symbol/);
  });

  it('rejects invalid input', () => {
    class M extends ModelBase {}
    track(M);
    expect(() => registerAccessResource(M as never, '')).to.throw(AuthzConfigError, /non-empty/);
    expect(() => registerAccessResource(M as never, '$global')).to.throw(AuthzConfigError, /not a resource type/);
    expect(() => registerAccessResource(M as never, 'reg-x', { relationScope: 'inner' as never })).to.throw(AuthzConfigError, /relationScope/);
    expect(() => registerAccessResource(M as never, 'reg-x', { permissions: { read: 'not a permission' } })).to.throw(AuthzConfigError, /not a valid read permission/);
    expect(() => registerAccessResource(M as never, 'reg-x', { permissions: { list: 'x:list' } as never })).to.throw(AuthzConfigError, /unknown permission key/);
    expect(() => registerAccessResource(M as never, 'reg-x', { attributes: [''] })).to.throw(AuthzConfigError, /attributes/);
    expect(() => registerAccessResource(undefined as never, 'reg-x')).to.throw(AuthzConfigError, /class/);
    expect(() => ScopeColumn('', 'org')).to.throw(AuthzConfigError, /column/);
    expect(() => ScopeColumn('org_id', '$global')).to.throw(AuthzConfigError, /scope type/);
    expect(() => OrmScope(M as never, '')).to.throw(AuthzConfigError, /relation/);
    expect(() => OrmScope(undefined as never, 'pool')).to.throw(AuthzConfigError, /class/);
    expect(isRegistered(M)).to.equal(false);
  });
});
