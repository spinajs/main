import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { AccessControl } from 'accesscontrol';
import { AsyncLocalStorage } from 'async_hooks';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';
import { OrmPermission, clearOrmPermissionRegistry } from '../src/orm-permission.js';
import { Forbidden } from '@spinajs/exceptions';

import './migration/rbac.migration.js';
import {
  AllPolicy,
  AllPolicyModel,
  AsyncCreateModel,
  AsyncCreatePolicy,
  DerivedBaseModel,
  DerivedBasePolicy,
  DerivedSubModel,
  DerivedSubPolicy,
  GenericNoOwnerModel,
  GenericNoOwnerPolicy,
  GenericPolicy,
  GenericPolicyModel,
  GhostScopeModel,
  InheritedPolicyModel,
  LazyPolicy,
  LazyPolicyModel,
  NakedModel,
  OwnerFieldOnlyModel,
  POLICY_CALLS,
  resetPolicyCalls,
  ScopedDefaultPolicy,
  ScopedModel,
  ScopedSubsetPolicy,
  SiblingAModel,
  SiblingAPolicy,
  SiblingBModel,
  SiblingBPolicy,
  SiblingUnregisteredModel,
  SiblingUnregisteredNakedModel,
} from './models/PolicyModels.js';
import { OrmException } from '@spinajs/orm';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

describe('OrmPermissionPolicy where-path', function () {
  this.timeout(15000);

  before(async () => {
    DI.register(SimpleDbAuthProvider).as(AuthProvider);
    DI.register(TestConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BasicPasswordProvider).as(PasswordProvider);
  });

  beforeEach(async () => {
    const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }

    await DI.resolve(Configuration, [null, null, [dir('./config')]]);
    await DI.resolve(Orm);

    resetPolicyCalls();

    // `DI.clearCache()` below (afterEach) wipes the whole DI cache, including the map
    // `@OrmPermission` writes to at import time — fixture policies only decorate ONCE, so
    // every test after the first needs them rebuilt here.
    clearOrmPermissionRegistry();
    OrmPermission(AllPolicyModel)(AllPolicy);
    OrmPermission(GenericPolicyModel)(GenericPolicy);
    OrmPermission(GenericNoOwnerModel)(GenericNoOwnerPolicy);
    OrmPermission(AsyncCreateModel)(AsyncCreatePolicy);
    OrmPermission(LazyPolicyModel)(LazyPolicy);
    OrmPermission(ScopedModel)(ScopedDefaultPolicy);
    OrmPermission(ScopedModel, 'subset')(ScopedSubsetPolicy);
    OrmPermission(SiblingAModel)(SiblingAPolicy);
    OrmPermission(SiblingBModel)(SiblingBPolicy);
    OrmPermission(DerivedBaseModel)(DerivedBasePolicy);
    OrmPermission(DerivedSubModel)(DerivedSubPolicy);
    // GhostScopeModel, SiblingUnregisteredModel and SiblingUnregisteredNakedModel are
    // deliberately left unregistered — their tests pin the fallback/fail-loud paths.

    ScopedDefaultPolicy.RejectCreate = false;
    ScopedSubsetPolicy.RejectCreate = false;
  });

  afterEach(() => {
    DI.clearCache();
  });

  // Resource value is normally `Record<string, string[]>` (action -> attributes); the
  // `string[]` arm additionally admits a role-level `$extend: [...]` entry.
  function grant(grants: Record<string, Record<string, Record<string, string[]> | string[]>>) {
    DI.get<AccessControl>('AccessControl')!.setGrants(grants);
  }

  async function owner() {
    return User.query().whereAnything('test@spinajs.pl').firstOrFail();
  }

  // query builders are thenables, not Promises — await inside so callers get a real Promise
  function as<T>(user: User, role: string | string[], fn: () => PromiseLike<T>): Promise<T> {
    const store = DI.resolve(AsyncLocalStorage);
    const roles = Array.isArray(role) ? role : [role];
    return store.run({ User: new User({ Id: user.Id, Role: roles }) }, async () => await fn());
  }

  describe('operation routing', () => {
    beforeEach(() => {
      grant({
        r: {
          PolicyAll: { 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
          PolicyGeneric: { 'read:own': ['*'], 'update:own': ['*'], 'delete:own': ['*'] },
        },
      });
    });

    it('select uses scopeRead', async () => {
      const u = await owner();
      await as(u, 'r', () => AllPolicyModel.all());
      expect(POLICY_CALLS).to.eql(['scopeRead']);
    });

    it('update uses scopeUpdate', async () => {
      const u = await owner();
      await as(u, 'r', () => AllPolicyModel.update({ Value: 'x' } as any).where('Id', 1));
      expect(POLICY_CALLS).to.eql(['scopeUpdate']);
    });

    it('delete uses scopeDelete', async () => {
      const u = await owner();
      // destroy() requires primary keys up front (unbounded-DELETE guard) — chaining
      // .where() after an empty call throws before the middleware even runs.
      await as(u, 'r', () => AllPolicyModel.destroy(1));
      expect(POLICY_CALLS).to.eql(['scopeDelete']);
    });

    it('a policy with only scope() serves read, update and delete', async () => {
      const u = await owner();
      await as(u, 'r', () => GenericPolicyModel.all());
      await as(u, 'r', () => GenericPolicyModel.update({ Value: 'x' } as any).where('Id', 1));
      await as(u, 'r', () => GenericPolicyModel.destroy(1));
      expect(POLICY_CALLS).to.eql(['scope', 'scope', 'scope']);
    });

    it('a subclass model declaring the same resource resolves the shared policy', async () => {
      const u = await owner();
      await as(u, 'r', () => InheritedPolicyModel.all());
      expect(POLICY_CALLS).to.eql(['scopeRead']);
    });
  });

  describe('fallbacks', () => {
    it('OwnerField model with no policy filters by owner column', async () => {
      grant({ r: { PolicyOwnerField: { 'read:own': ['*'] } } });
      const u = await owner();

      await new OwnerFieldOnlyModel({ UserId: u.Id, Value: 'mine' } as any).insert();
      await new OwnerFieldOnlyModel({ UserId: u.Id + 999, Value: 'theirs' } as any).insert();

      const rows = (await as(u, 'r', () => OwnerFieldOnlyModel.all())) as OwnerFieldOnlyModel[];

      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('mine');
    });

    it('model with no policy and no OwnerField throws OrmException', async () => {
      grant({ r: { PolicyNaked: { 'read:own': ['*'] } } });
      const u = await owner();

      await expect(as(u, 'r', () => NakedModel.all())).to.be.rejectedWith(/no OrmPermissionPolicy registered/);
    });

    it(':any grant skips policies entirely', async () => {
      grant({ admin: { PolicyAll: { 'read:any': ['*'] } } });
      const u = await owner();

      await new AllPolicyModel({ UserId: u.Id, Value: 'alpha' } as any).insert();
      await new AllPolicyModel({ UserId: u.Id, Value: 'beta' } as any).insert();

      const rows = (await as(u, 'admin', () => AllPolicyModel.all())) as AllPolicyModel[];

      expect(POLICY_CALLS).to.eql([]);
      expect(rows).to.be.an('array').with.length(2);
    });
  });

  describe('a policy runs exactly once per query', () => {
    it('clone() does not re-run the policy', async () => {
      grant({ r: { PolicyAll: { 'read:own': ['*'] } } });
      const u = await owner();

      await new AllPolicyModel({ UserId: u.Id, Value: 'readable' } as any).insert();

      resetPolicyCalls();

      await as(u, 'r', async () => {
        const query = AllPolicyModel.select();
        const countQuery = query.clone();

        await query;
        await countQuery.selectCount();
      });

      expect(POLICY_CALLS).to.eql(['scopeRead']);
    });

    it('a Lazy policy is not re-run when the deferred statement compiles', async () => {
      grant({ r: { PolicyLazy: { 'read:own': ['*'] } } });
      const u = await owner();

      await new LazyPolicyModel({ UserId: u.Id, Value: 'readable' } as any).insert();
      await new LazyPolicyModel({ UserId: u.Id, Value: 'other' } as any).insert();

      resetPolicyCalls();

      const rows = (await as(u, 'r', () => LazyPolicyModel.select())) as LazyPolicyModel[];

      expect(POLICY_CALLS).to.eql(['scopeRead']);
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('readable');
    });
  });

  describe('insert', () => {
    it('insert uses authorizeCreate and suppresses OwnerField stamping', async () => {
      grant({ r: { PolicyAll: { 'create:own': ['*'] } } });
      const u = await owner();

      await as(u, 'r', async () => {
        await new AllPolicyModel({ UserId: 4242, Value: 'from-payload' } as any).insert();
      });

      expect(POLICY_CALLS).to.eql(['authorizeCreate']);

      const row = await AllPolicyModel.where('Value', 'stamped-by-policy').firstOrFail();
      expect(row.UserId).to.eq(4242);
    });

    it('awaits an async authorizeCreate before the row lands (allow path)', async () => {
      grant({ r: { PolicyAsync: { 'create:own': ['*'] } } });
      const u = await owner();
      AsyncCreatePolicy.AllowedOwners = [u.Id];

      await as(u, 'r', async () => {
        await new AsyncCreateModel({ UserId: u.Id, Value: 'from-payload' } as any).insert();
      });

      expect(POLICY_CALLS).to.eql(['authorizeCreate:start', 'authorizeCreate:allow']);

      const row = await AsyncCreateModel.where('Value', `checked-for-${u.Id}`).firstOrFail();
      expect(row.UserId).to.eq(u.Id);
    });

    it('a rejecting async authorizeCreate prevents the insert', async () => {
      grant({ r: { PolicyAsync: { 'create:own': ['*'] } } });
      const u = await owner();
      AsyncCreatePolicy.AllowedOwners = [];

      await expect(
        as(u, 'r', async () => {
          await new AsyncCreateModel({ UserId: u.Id, Value: 'forged' } as any).insert();
        }),
      ).to.be.rejectedWith(/is not assigned to this user/);

      expect(POLICY_CALLS).to.eql(['authorizeCreate:start', 'authorizeCreate:reject']);
      expect(await AsyncCreateModel.where('Value', 'forged').first()).to.be.undefined;
    });

    it('OwnerField model with no policy stamps the owner column on insert', async () => {
      grant({ r: { PolicyOwnerField: { 'create:own': ['*'] } } });
      const u = await owner();

      await as(u, 'r', async () => {
        await new OwnerFieldOnlyModel({ UserId: u.Id + 999, Value: 'forged' } as any).insert();
      });

      const row = await OwnerFieldOnlyModel.where('Value', 'forged').firstOrFail();
      expect(row.UserId).to.eq(u.Id);
    });

    it('a registered policy implementing only scope() falls back to OwnerField and stamps the owner column (IDOR closure)', async () => {
      // Regression case for the OwnerField-fallback fix: GenericPolicy never implements
      // authorizeCreate, but GenericPolicyModel has @ResourceOwner — pre-refactor this
      // combination stamped the owner column and allowed the insert; a registered policy
      // that only implements scope() must not shadow that into a denial.
      grant({ r: { PolicyGeneric: { 'create:own': ['*'] } } });
      const u = await owner();

      await as(u, 'r', async () => {
        await new GenericPolicyModel({ UserId: u.Id + 999, Value: 'forged' } as any).insert();
      });

      const row = await GenericPolicyModel.where('Value', 'forged').firstOrFail();
      expect(row.UserId).to.eq(u.Id);
    });

    it('a registered policy with no authorizeCreate override and no OwnerField still denies, as Forbidden', async () => {
      // Contrast with the GenericPolicy case above: with no OwnerField to fall back to, the
      // base OrmPermissionPolicy.authorizeCreate default runs and must deny — and that denial
      // is an authorization failure (Forbidden/403), not a config error (OrmException).
      grant({ r: { PolicyGenericNoOwner: { 'create:own': ['*'] } } });
      const u = await owner();

      await expect(
        as(u, 'r', async () => {
          await new GenericNoOwnerModel({ Value: 'x' } as any).insert();
        }),
      ).to.be.rejectedWith(Forbidden, /does not implement authorizeCreate/);
    });

    it('model with neither policy nor OwnerField throws OrmException on :own insert', async () => {
      grant({ r: { PolicyNaked: { 'create:own': ['*'] } } });
      const u = await owner();

      await expect(
        as(u, 'r', async () => {
          await new NakedModel({ Value: 'x' } as any).insert();
        }),
      ).to.be.rejectedWith(OrmException, /no OrmPermissionPolicy registered/);
    });

    it('create:any skips authorizeCreate', async () => {
      grant({ admin: { PolicyAll: { 'create:any': ['*'] } } });
      const u = await owner();

      await as(u, 'admin', async () => {
        await new AllPolicyModel({ UserId: u.Id, Value: 'unstamped' } as any).insert();
      });

      expect(POLICY_CALLS).to.eql([]);

      const row = await AllPolicyModel.where('Value', 'unstamped').firstOrFail();
      expect(row.UserId).to.eq(u.Id);
    });

    describe('multi-role OR-composition', () => {
      beforeEach(() => {
        grant({
          roleScopedCreateDefault: { PolicyScoped: { 'create:own': ['*'] } },
          roleScopedCreateSubset: { PolicyScoped: { 'create:own': ['scope:subset'] } },
        });
      });

      it('first-success-wins: row lands via the second policy after the first rejects', async () => {
        const u = await owner();
        ScopedDefaultPolicy.RejectCreate = true;
        ScopedSubsetPolicy.RejectCreate = false;

        await as(u, ['roleScopedCreateDefault', 'roleScopedCreateSubset'], async () => {
          await new ScopedModel({ UserId: u.Id, Value: 'from-payload' } as any).insert();
        });

        expect(POLICY_CALLS).to.eql(['authorizeCreate:default', 'authorizeCreate:subset']);

        const row = await ScopedModel.where('Value', 'created-by-subset').firstOrFail();
        expect(row.UserId).to.eq(u.Id);
      });

      it('all-reject: insert is rejected and the last policy error surfaces', async () => {
        const u = await owner();
        ScopedDefaultPolicy.RejectCreate = true;
        ScopedSubsetPolicy.RejectCreate = true;

        await expect(
          as(u, ['roleScopedCreateDefault', 'roleScopedCreateSubset'], async () => {
            await new ScopedModel({ UserId: u.Id, Value: 'from-payload-multi-reject' } as any).insert();
          }),
        ).to.be.rejectedWith(/subset policy rejects create/);

        expect(POLICY_CALLS).to.eql(['authorizeCreate:default', 'authorizeCreate:subset']);
        expect(await ScopedModel.where('Value', 'from-payload-multi-reject').first()).to.be.undefined;
      });
    });
  });

  describe('named scopes', () => {
    beforeEach(() => {
      grant({
        roleSubset: { PolicyScoped: { 'read:own': ['scope:subset'] } },
        roleDefault: { PolicyScoped: { 'read:own': ['*'] } },
        roleGhost: { PolicyGhostScope: { 'read:own': ['scope:ghost'] } },
      });
    });

    it("a 'scope:subset' grant attribute routes to the named policy", async () => {
      const u = await owner();
      await new ScopedModel({ UserId: u.Id, Value: 'default-visible' } as any).insert();
      await new ScopedModel({ UserId: u.Id, Value: 'subset-visible' } as any).insert();
      await new ScopedModel({ UserId: u.Id, Value: 'neither' } as any).insert();

      resetPolicyCalls();

      const rows = (await as(u, 'roleSubset', () => ScopedModel.all())) as ScopedModel[];

      expect(POLICY_CALLS).to.eql(['subset']);
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('subset-visible');
    });

    it("attributes ['*'] route to the default policy", async () => {
      const u = await owner();
      await new ScopedModel({ UserId: u.Id, Value: 'default-visible' } as any).insert();
      await new ScopedModel({ UserId: u.Id, Value: 'subset-visible' } as any).insert();

      resetPolicyCalls();

      const rows = (await as(u, 'roleDefault', () => ScopedModel.all())) as ScopedModel[];

      expect(POLICY_CALLS).to.eql(['default']);
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('default-visible');
    });

    it('two roles with different scopes OR-compose', async () => {
      // A caller-side WHERE ('UserId', u.Id) is added on top of the RBAC scope so the SQL
      // shape is provable: correct grouping is `UserId=u.Id AND (default OR subset)`. If the
      // OR ever leaked to the top level (or the base WHERE got dropped), the other user's
      // 'default-visible'/'subset-visible' rows would leak into the result too — this seeding
      // makes that a detectable difference in row count/content, not just an equal-or-not.
      const u = await owner();
      const other = await User.query().whereAnything('test-banned@spinajs.pl').firstOrFail();

      await new ScopedModel({ UserId: u.Id, Value: 'default-visible' } as any).insert();
      await new ScopedModel({ UserId: u.Id, Value: 'subset-visible' } as any).insert();
      await new ScopedModel({ UserId: u.Id, Value: 'neither' } as any).insert();
      await new ScopedModel({ UserId: other.Id, Value: 'default-visible' } as any).insert();
      await new ScopedModel({ UserId: other.Id, Value: 'subset-visible' } as any).insert();

      resetPolicyCalls();

      const rows = (await as(u, ['roleSubset', 'roleDefault'], () => ScopedModel.where('UserId', u.Id).all())) as ScopedModel[];

      expect(POLICY_CALLS).to.have.members(['default', 'subset']);
      expect(rows).to.be.an('array').with.length(2);
      expect(rows.every((r) => r.UserId === u.Id)).to.be.true;
      expect(rows.map((r) => r.Value).sort()).to.eql(['default-visible', 'subset-visible']);
    });

    it("a '*'-attribute role does NOT absorb another role's scope token", async () => {
      // Same two-role user as above: a combined `ac.can(roles)` query would union attributes
      // to ['*', 'scope:subset'] and a naive '*' short-circuit would drop the subset policy
      // entirely. Per-role resolution must still run it.
      const u = await owner();
      await new ScopedModel({ UserId: u.Id, Value: 'subset-visible' } as any).insert();

      resetPolicyCalls();

      await as(u, ['roleSubset', 'roleDefault'], () => ScopedModel.all());

      expect(POLICY_CALLS).to.include('subset');
    });

    it("KNOWN LIMITATION: a role's scope: token is silently absorbed by a role it $extends granting '*' on the same resource", async () => {
      // Contrast with the test above: that one holds for two SEPARATE roles queried
      // independently. Here a SINGLE role $extends another, and accesscontrol unions grant
      // attributes across the whole $extend chain BEFORE this module ever sees them —
      // Notation.Glob.union(['*'], ['scope:subset']) collapses to ['*'], so the 'scope:subset'
      // token is lost and resolution silently falls through to the default policy instead of
      // the named one. This pins the ACTUAL (undesired) behavior, not the desired one — see
      // the warning on PERMISSION_SCOPE_ATTR_PREFIX.
      grant({
        roleScopedPackage: { PolicyScoped: { 'read:own': ['*'] } },
        roleScopedExtender: { $extend: ['roleScopedPackage'], PolicyScoped: { 'read:own': ['scope:subset'] } },
      });
      const u = await owner();
      await new ScopedModel({ UserId: u.Id, Value: 'default-visible' } as any).insert();
      await new ScopedModel({ UserId: u.Id, Value: 'subset-visible' } as any).insert();

      resetPolicyCalls();

      const rows = (await as(u, 'roleScopedExtender', () => ScopedModel.all())) as ScopedModel[];

      expect(POLICY_CALLS).to.eql(['default']);
      expect(rows.map((r) => r.Value)).to.eql(['default-visible']);
    });

    it('a granted scope with no registered policy throws OrmException', async () => {
      const u = await owner();

      await expect(as(u, 'roleGhost', () => GhostScopeModel.all())).to.be.rejectedWith(OrmException, /scope 'ghost'/);
    });
  });

  describe('model-precise resolution (shared @OrmResource)', () => {
    beforeEach(() => {
      grant({
        r: {
          PolicySibling: { 'read:own': ['*'] },
          PolicyDerived: { 'read:own': ['*'] },
        },
      });
    });

    it('two unrelated models sharing one resource each resolve their OWN policy', async () => {
      const u = await owner();
      await new SiblingAModel({ UserId: u.Id, Value: 'a-visible' } as any).insert();
      await new SiblingBModel({ UserId: u.Id, Value: 'b-visible' } as any).insert();

      resetPolicyCalls();
      const aRows = (await as(u, 'r', () => SiblingAModel.all())) as SiblingAModel[];
      expect(POLICY_CALLS).to.eql(['siblingA']);
      expect(aRows.map((r) => r.Value)).to.eql(['a-visible']);

      resetPolicyCalls();
      const bRows = (await as(u, 'r', () => SiblingBModel.all())) as SiblingBModel[];
      expect(POLICY_CALLS).to.eql(['siblingB']);
      expect(bRows.map((r) => r.Value)).to.eql(['b-visible']);
    });

    it('a shared-resource model with no own policy and no matching ancestor falls back to OwnerField', async () => {
      const u = await owner();
      await new SiblingUnregisteredModel({ UserId: u.Id, Value: 'mine' } as any).insert();
      await new SiblingUnregisteredModel({ UserId: u.Id + 999, Value: 'theirs' } as any).insert();

      resetPolicyCalls();
      const rows = (await as(u, 'r', () => SiblingUnregisteredModel.all())) as SiblingUnregisteredModel[];

      // no bound policy matched -> OwnerFieldPolicy fallback, no sibling policy ran
      expect(POLICY_CALLS).to.eql([]);
      expect(rows).to.be.an('array').with.length(1);
      expect(rows[0].Value).to.eq('mine');
    });

    it('a shared-resource model with no own policy, no matching ancestor and no OwnerField fails loud', async () => {
      const u = await owner();

      await expect(as(u, 'r', () => SiblingUnregisteredNakedModel.all())).to.be.rejectedWith(OrmException, /no OrmPermissionPolicy registered/);
    });

    it('most-derived-wins: an exact-bound subclass policy shadows its ancestor-bound sibling', async () => {
      const u = await owner();

      resetPolicyCalls();
      await as(u, 'r', () => DerivedSubModel.all());
      expect(POLICY_CALLS).to.eql(['derivedSub']);
    });

    it('the ancestor model still resolves its own policy when queried directly', async () => {
      const u = await owner();

      resetPolicyCalls();
      await as(u, 'r', () => DerivedBaseModel.all());
      expect(POLICY_CALLS).to.eql(['derivedBase']);
    });
  });
});
