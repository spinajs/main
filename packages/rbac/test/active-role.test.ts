import { BasicPasswordProvider } from '../src/password.js';
import { Bootstrapper, DI } from '@spinajs/di';
import chaiAsPromised from 'chai-as-promised';
import * as chai from 'chai';
import { PasswordProvider, SimpleDbAuthProvider, AuthProvider, User, IRbacAsyncStorage } from '../src/index.js';
import { expect } from 'chai';
import { Configuration } from '@spinajs/configuration';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { Orm } from '@spinajs/orm';
import { Forbidden } from '@spinajs/exceptions';
import { join, normalize, resolve } from 'path';
import { TestConfiguration } from './common.test.js';
import { AccessControl } from 'accesscontrol';

import './migration/rbac.migration.js';
import { AsyncLocalStorage } from 'async_hooks';
import { ResourceModel } from './models/ResourceModel.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * The rbac query middleware should honor IRbacAsyncStorage.ActiveRole — when
 * set, permission checks must use ONLY that role even if the user has more
 * roles in User.Role. When unset, the full role list is used.
 */
describe('Rbac ActiveRole middleware', function () {
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

    // Override grants for this suite: admin gets read:any, normal gets read:own.
    // A user with both roles can switch between them via ActiveRole to widen
    // or narrow what queries return.
    const ac = DI.get<AccessControl>('AccessControl')!;
    ac.setGrants({
      admin: {
        Test: {
          'read:any': ['*'],
        },
      },
      normal: {
        Test: {
          'read:own': ['*'],
        },
      },
      // accesscontrol requires every role referenced in checks to exist —
      // declare guest with no grants on Test so we can test the "denied" path.
      guest: {
        SomethingElse: {
          'read:any': ['*'],
        },
      },
    });
  });

  afterEach(() => {
    DI.clearCache();
  });

  it('ActiveRole=admin lets read:any through with no owner filter', async () => {
    const store = DI.resolve(AsyncLocalStorage);
    const result = await store.run<Promise<ResourceModel | undefined>, IRbacAsyncStorage[]>(
      {
        User: new User({
          Id: 1,
          Role: ['admin', 'normal'],
        }),
        ActiveRole: 'admin',
      },
      async () => {
        // No throw means the middleware allowed the query
        return await ResourceModel.where('Id', '>', 0).first();
      },
    );

    expect(result).to.be.not.null;
  });

  it('ActiveRole=normal forces read:own owner filter even though user has admin role too', () => {
    const store = DI.resolve(AsyncLocalStorage);

    // Synchronous: afterQueryCreation runs in the SelectQueryBuilder
    // constructor, so toDB() right after .where() reflects the middleware
    // changes without executing the query.
    const sql = store.run<string, IRbacAsyncStorage[]>(
      {
        User: new User({
          Id: 42,
          Role: ['admin', 'normal'],
        }),
        ActiveRole: 'normal',
      },
      () => {
        const builder = ResourceModel.where('Id', '>', 0);
        const compiled: any = builder.toDB();
        return Array.isArray(compiled) ? compiled[0].expression : compiled.expression;
      },
    );

    expect(sql).to.match(/UserId/i);
  });

  it('ActiveRole pointing to a role without any permission throws Forbidden', () => {
    const store = DI.resolve(AsyncLocalStorage);

    const build = () =>
      store.run<unknown, IRbacAsyncStorage[]>(
        {
          User: new User({
            Id: 1,
            Role: ['admin', 'guest'],
          }),
          // guest has no grants on Test, even though admin (also assigned) does
          ActiveRole: 'guest',
        },
        () => ResourceModel.where('Id', '>', 0),
      );

    expect(build).to.throw(Forbidden);
  });

  it('Without ActiveRole the full role list is used (admin role wins)', () => {
    const store = DI.resolve(AsyncLocalStorage);

    const sql = store.run<string, IRbacAsyncStorage[]>(
      {
        User: new User({
          Id: 42,
          Role: ['admin', 'normal'],
        }),
        // ActiveRole intentionally omitted — accesscontrol unions both roles
      },
      () => {
        const builder = ResourceModel.where('Id', '>', 0);
        const compiled: any = builder.toDB();
        return Array.isArray(compiled) ? compiled[0].expression : compiled.expression;
      },
    );

    // admin's read:any short-circuits before read:own → no owner filter appended
    expect(sql).to.not.match(/UserId/i);
  });
});
