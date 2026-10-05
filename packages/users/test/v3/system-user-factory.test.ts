import { AsyncLocalStorage } from 'async_hooks';
import { DI, Injectable } from '@spinajs/di';
import { Connection, Model, QueryMiddleware } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';
import { SYSTEM, currentPrincipal, runWithPrincipal } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import { v4 as uuidv4 } from 'uuid';

import { PasswordProvider, RBAC_USER_MODEL, SYSTEM_LOGIN, User } from '../../src/index.js';
import { bootUsersDb, registerUsersTestHost } from '../support/users-db.js';

chai.use(chaiAsPromised);

/** An application's user model; sharing the `users` table with `User` is the trick `UserBase` and `User` use. */
@Connection('default')
@Model('users')
class AppUserModel extends User {}

let scoping = false;

const STALE_AUTHZ_SINGLETONS = ['ConfigRoleStore', 'DbAssignmentStore', 'UsersTestRbac', 'OrmResourceAdapter', 'UserResourceAdapter', 'UserSelfRelation', 'UsersSelfRelation', 'ConfigScopeAttributeSchemas', 'OrmAuthzContributor', 'DefaultRolesBootCheck', 'OwnRolesTokenRolePolicy', 'OrmNativeCompiler', 'RbacOrmCompiler', 'DefaultAuthzAdmin'];

// Stands in for authz-orm's query middleware, which cannot be loaded into this package's suites (its shield needs a booted
// host before any query, migrations included). Scopes the model to nothing for every principal but SYSTEM.
@Injectable(QueryMiddleware)
export class ScopeUserModelToNothing extends QueryMiddleware {
  afterQueryCreation(builder: QueryBuilder): void {
    if (scoping && builder.Model === (AppUserModel as unknown) && currentPrincipal() !== SYSTEM) {
      (builder as unknown as { where(column: string, value: string): void }).where('Login', '__never__');
    }
  }

  beforeQueryExecution(): void {
    // the scope is added when the query is created
  }
}

const caller = (): Principal => ({ type: 'user', id: uuidv4(), authenticated: true, source: 'session', attributes: {}, ceiling: { roles: ['normal'] } });

// Ported from users legacy-v2/system-user-factory.test.ts rows 1-4 (B09, B20): the factory runs under runAs(SYSTEM). The 2.x
// OrmPermissionPolicy and AccessControl setup becomes a query middleware that scopes the model to nothing outside SYSTEM.
describe('RbacSystemUserFactory', function () {
  this.timeout(30000);

  before(() => {
    // The run restores authz singletons built by an earlier suite (role store, assignment store, contributors) and they hide this suite's roles.
    for (const key of STALE_AUTHZ_SINGLETONS) DI.RootContainer.uncache(key);
    registerUsersTestHost();
  });

  beforeEach(async () => {
    await bootUsersDb();
    scoping = true;

    DI.register(AppUserModel).asValue(RBAC_USER_MODEL, true);

    const provider = await DI.resolve(PasswordProvider);
    const existing = await User.select().where('Login', SYSTEM_LOGIN).first();
    if (!existing) {
      await new User({
        Email: '__system__@spinajs.pl',
        Login: SYSTEM_LOGIN,
        Password: await provider.hash('bbbb'),
        IsActive: true,
        Uuid: 'system-uuid-fixture',
      }).insert();
    }
  });

  afterEach(() => {
    scoping = false;
    DI.clearCache();
  });

  it('returns an instance of the registered user model, not the base class', async () => {
    const system = await DI.resolve<User>('RbacSystemUserFactory');

    expect(system).to.be.instanceOf(AppUserModel);
    expect(system.Login).to.eq(SYSTEM_LOGIN);
  });

  it('is not row-scoped by the registered model rbac hook', async () => {
    // Inside a scoped request context the scope WOULD apply (the control below), yet the system lookup still finds its account.
    const system = await runWithPrincipal(caller(), async () => DI.resolve<User>('RbacSystemUserFactory'));

    expect(system).to.be.instanceOf(AppUserModel);
    expect(system.Login).to.eq(SYSTEM_LOGIN);
  });

  it('control: the same query IS scoped outside runAs(SYSTEM)', async () => {
    const found = await runWithPrincipal(caller(), async () => AppUserModel.select().where('Login', SYSTEM_LOGIN).first());

    expect(found).to.eq(undefined);
  });

  it('preserves the surrounding store rather than replacing it', async () => {
    const principal = caller();
    const store = DI.resolve(AsyncLocalStorage);
    const legacy = new AppUserModel({ Id: 1 } as any);

    const seen = await runWithPrincipal(principal, async () =>
      store.run({ ...store.getStore(), User: legacy, ActiveRole: 'normal' }, async () => {
        await DI.resolve<User>('RbacSystemUserFactory');
        return { principal: currentPrincipal(), store: store.getStore() as { User?: User; ActiveRole?: string; SkipModelPermissionCheck?: boolean } };
      }),
    );

    expect(seen.principal).to.eq(principal);
    expect(seen.principal.ceiling?.roles).to.deep.equal(['normal']);
    expect(seen.store.User).to.eq(legacy);
    expect(seen.store.ActiveRole).to.eq('normal');
    // the skip belongs to the factory's own nested context, never to the caller's
    expect(seen.store.SkipModelPermissionCheck).to.eq(undefined);
  });
});
