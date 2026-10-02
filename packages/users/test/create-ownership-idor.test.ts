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

import './migration/rbac.migration.js';
import { ResourceModel } from './models/ResourceModel.js';

chai.use(chaiAsPromised);

function dir(path: string) {
  return resolve(normalize(join(process.cwd(), 'test', path)));
}

/**
 * Ownership enforcement on INSERT.
 *
 * The middleware's insert branch was unreachable in two independent ways: the
 * `InsertQueryBuilder` constructor never invoked `afterQueryCreation`, and the
 * builder-to-permission table had no entry for inserts, so the lookup would have thrown
 * a TypeError had it ever been reached. `createOwn` / `createAny` were therefore never
 * enforced at the ORM layer and nothing tested them.
 *
 * The check now runs in `beforeQueryExecution`, because the row payload does not exist
 * until `values()` has been called — stamping the owner column at construction time would
 * have been silently overwritten.
 */
describe('Ownership enforcement on inserts (IDOR regression)', function () {
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
  });

  afterEach(() => {
    DI.clearCache();
  });

  function grant(grants: Record<string, Record<string, Record<string, string[]>>>) {
    DI.get<AccessControl>('AccessControl')!.setGrants(grants);
  }

  async function users() {
    const attacker = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    const victim = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();
    return { attacker, victim };
  }

  it('createOwn forces the owner column to the acting user', async () => {
    grant({ owner: { Test: { 'create:own': ['*'], 'read:any': ['*'] } } });

    const { attacker } = await users();
    const store = DI.resolve(AsyncLocalStorage);

    await store.run({ User: new User({ Id: attacker.Id, Role: ['owner'] }) }, async () => {
      await new ResourceModel({ UserId: attacker.Id, Value: 'mine' } as any).insert();
    });

    const row = await ResourceModel.where({ Value: 'mine' }).firstOrFail();
    expect(row.UserId).to.eq(attacker.Id);
  });

  it('createOwn overwrites a forged owner id rather than trusting the payload', async () => {
    grant({ owner: { Test: { 'create:own': ['*'], 'read:any': ['*'] } } });

    const { attacker, victim } = await users();
    const store = DI.resolve(AsyncLocalStorage);

    // The attacker hand-sets UserId to the victim so the row would show up under the
    // victim's account. The middleware must overwrite it, not merge with it.
    await store.run({ User: new User({ Id: attacker.Id, Role: ['owner'] }) }, async () => {
      await new ResourceModel({ UserId: victim.Id, Value: 'forged' } as any).insert();
    });

    const row = await ResourceModel.where({ Value: 'forged' }).firstOrFail();
    expect(row.UserId).to.eq(attacker.Id);
    expect(row.UserId).to.not.eq(victim.Id);
  });

  it('createAny leaves the payload alone', async () => {
    grant({ admin: { Test: { 'create:any': ['*'], 'read:any': ['*'] } } });

    const { attacker, victim } = await users();
    const store = DI.resolve(AsyncLocalStorage);

    await store.run({ User: new User({ Id: attacker.Id, Role: ['admin'] }), ActiveRole: 'admin' }, async () => {
      await new ResourceModel({ UserId: victim.Id, Value: 'on-behalf' } as any).insert();
    });

    const row = await ResourceModel.where({ Value: 'on-behalf' }).firstOrFail();
    expect(row.UserId).to.eq(victim.Id);
  });

  it('no create grant is refused', async () => {
    grant({ reader: { Test: { 'read:own': ['*'] } } });

    const { attacker } = await users();
    const store = DI.resolve(AsyncLocalStorage);

    await expect(
      store.run({ User: new User({ Id: attacker.Id, Role: ['reader'] }) }, async () => {
        await new ResourceModel({ UserId: attacker.Id, Value: 'denied' } as any).insert();
      }),
    ).to.be.rejectedWith(/create permission/);

    expect(await ResourceModel.where({ Value: 'denied' }).first()).to.be.undefined;
  });
});
