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

import './migration/rbac.migration.js';
import { AllPolicy, AllPolicyModel, AsyncCreateModel, AsyncCreatePolicy, GenericPolicy, GenericPolicyModel, InheritedPolicyModel, LazyPolicy, LazyPolicyModel, NakedModel, OwnerFieldOnlyModel, POLICY_CALLS, resetPolicyCalls } from './models/PolicyModels.js';

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
    OrmPermission(AsyncCreateModel)(AsyncCreatePolicy);
    OrmPermission(LazyPolicyModel)(LazyPolicy);
  });

  afterEach(() => {
    DI.clearCache();
  });

  function grant(grants: Record<string, Record<string, Record<string, string[]>>>) {
    DI.get<AccessControl>('AccessControl')!.setGrants(grants);
  }

  async function owner() {
    return User.query().whereAnything('test@spinajs.pl').firstOrFail();
  }

  // query builders are thenables, not Promises — await inside so callers get a real Promise
  function as<T>(user: User, role: string, fn: () => PromiseLike<T>): Promise<T> {
    const store = DI.resolve(AsyncLocalStorage);
    return store.run({ User: new User({ Id: user.Id, Role: [role] }) }, async () => await fn());
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
});
