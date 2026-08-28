import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { expect } from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, RBAC_USER_MODEL } from '../src/index.js';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Connection, Model, Orm } from '@spinajs/orm';
import { AccessControl } from 'accesscontrol';
import { AsyncLocalStorage } from 'async_hooks';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';

import './migration/rbac.migration.js';
import { OrmResource } from '../src/decorators.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * An application's user model, standing in for what a real app registers at `RbacUserModel`:
 * it declares an rbac resource and a read hook that constrains every query built from it.
 * Sharing the `users` table and connection with `User` is the same trick `UserBase`/`User`
 * themselves use.
 */
@Connection('default')
@Model('users')
@OrmResource('users')
export class AppUserModel extends User {
  public static rbacRead(this: any): void {
    // Deliberately matches nothing: any query that reaches this hook comes back empty, which
    // is what makes "the system lookup is not row-scoped" observable.
    this.where('Login', '__never__');
  }
}

/**
 * `RbacSystemUserFactory` has two jobs that pull in opposite directions.
 *
 * It must never be row-scoped: `_user_or_system` resolves it from inside live request
 * contexts, so an application model's own read hook would otherwise be able to make the
 * system account unfindable. It used to buy that by querying the base `User` class.
 *
 * But its result is written straight into `storage.User` by machine-token policies, so it is
 * the object an application's rbac hooks are handed on exactly those requests — and an
 * instance of a class the application does not use carries none of the members those hooks
 * read. Anything the application puts on its own user model was missing there and present
 * everywhere else.
 */
describe('RbacSystemUserFactory', function () {
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

    // What an application does at boot to make the framework build user queries with its own
    // model ( override=true, exactly as a real app's bootstrapper does ).
    DI.register(AppUserModel).asValue(RBAC_USER_MODEL, true);

    const provider = await DI.resolve(PasswordProvider);
    const existing = await User.select().where('Login', '__system__').first();
    if (!existing) {
      await new User({
        Email: '__system__@spinajs.pl',
        Login: '__system__',
        Password: await provider.hash('bbbb'),
        Role: ['system'],
        IsActive: true,
        Uuid: 'system-uuid-fixture',
      }).insert();
    }
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('returns an instance of the registered user model, not the base class', async () => {
    const system = await DI.resolve<User>('RbacSystemUserFactory');

    expect(system).to.be.instanceOf(AppUserModel);
    expect(system.Login).to.eq('__system__');
  });

  it('is not row-scoped by the registered model rbac hook', async () => {
    DI.get<AccessControl>('AccessControl')!.setGrants({ r: { users: { 'read:own': ['*'] } } });

    const store = DI.resolve(AsyncLocalStorage);
    const caller = new AppUserModel({ Id: 1, Role: ['r'] } as any);

    // Inside a scoped request context the hook WOULD apply — proven by the control below —
    // yet the system lookup still finds its account.
    const system = await store.run({ User: caller }, () => DI.resolve<User>('RbacSystemUserFactory'));

    expect(system).to.be.instanceOf(AppUserModel);
    expect(system.Login).to.eq('__system__');
  });

  it('control: the same query IS scoped without the skip', async () => {
    DI.get<AccessControl>('AccessControl')!.setGrants({ r: { users: { 'read:own': ['*'] } } });

    const store = DI.resolve(AsyncLocalStorage);
    const caller = new AppUserModel({ Id: 1, Role: ['r'] } as any);

    const found = await store.run({ User: caller }, () => AppUserModel.select().where('Login', '__system__').first());

    expect(found).to.eq(undefined);
  });

  it('preserves the surrounding store rather than replacing it', async () => {
    const store = DI.resolve(AsyncLocalStorage);
    const caller = new AppUserModel({ Id: 1, Role: ['r'] } as any);

    const seen = await store.run({ User: caller, ActiveRole: 'r' }, async () => {
      await DI.resolve<User>('RbacSystemUserFactory');
      return store.getStore() as { User?: User; ActiveRole?: string; SkipModelPermissionCheck?: boolean };
    });

    expect(seen.User).to.eq(caller);
    expect(seen.ActiveRole).to.eq('r');
    // the skip belongs to the factory's own nested context, never to the caller's
    expect(seen.SkipModelPermissionCheck).to.eq(undefined);
  });
});
