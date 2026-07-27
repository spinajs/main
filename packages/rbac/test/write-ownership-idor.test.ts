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
 * Ownership enforcement on write queries.
 *
 * The rbac query middleware injects "owner_field = current user" for :own
 * scopes. Historically it ran only for SELECT builders, so UPDATE and DELETE
 * escaped ownership entirely — any authenticated user with a :own grant could
 * modify or delete rows they did not own (an IDOR). These tests exercise a
 * properly registered resource model (@Model + @OrmResource + @ResourceOwner)
 * and prove the constraint is now applied to writes.
 */
describe('Ownership enforcement on write queries (IDOR regression)', function () {
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

    const ac = DI.get<AccessControl>('AccessControl')!;
    ac.setGrants({
      owner: {
        Test: {
          'update:own': ['*'],
          'delete:own': ['*'],
          'read:own': ['*'],
        },
      },
    });
  });

  afterEach(() => {
    DI.clearCache();
  });

  async function seed() {
    const attacker = await User.query().whereAnything('test@spinajs.pl').firstOrFail();
    const victim = await User.query().whereAnything('test-notactive@spinajs.pl').firstOrFail();

    const attackerRow = new ResourceModel({ UserId: attacker.Id, Value: 'attacker' } as any);
    await attackerRow.insert();

    const victimRow = new ResourceModel({ UserId: victim.Id, Value: 'victim' } as any);
    await victimRow.insert();

    return { attacker, victim, attackerRow, victimRow };
  }

  it('UPDATE with :own scope cannot touch another user\'s row via an OR lookup', async () => {
    const { attacker, attackerRow, victimRow } = await seed();
    const store = DI.resolve(AsyncLocalStorage);

    await store.run({ User: new User({ Id: attacker.Id, Role: ['owner'] }) }, async () => {
      await ResourceModel.update({ Value: 'hacked' }).where(function () {
        this.where('Id', attackerRow.Id).orWhere('Id', victimRow.Id);
      });
    });

    const attackerAfter = await ResourceModel.where({ Id: attackerRow.Id }).firstOrFail();
    const victimAfter = await ResourceModel.where({ Id: victimRow.Id }).firstOrFail();

    expect(attackerAfter.Value).to.eq('hacked');
    expect(victimAfter.Value).to.eq('victim');
  });

  it('DELETE with :own scope cannot delete another user\'s row in a multi-key destroy', async () => {
    const { attacker, attackerRow, victimRow } = await seed();
    const store = DI.resolve(AsyncLocalStorage);

    // The attacker asks for both rows by key. `destroy()` refuses an unbounded DELETE, so
    // this is the real attack shape: a bounded key set that reaches beyond the caller. The
    // ownership middleware has to AND its owner constraint onto it.
    await store.run({ User: new User({ Id: attacker.Id, Role: ['owner'] }) }, async () => {
      await ResourceModel.destroy([attackerRow.Id, victimRow.Id]);
    });

    const attackerAfter = await ResourceModel.where({ Id: attackerRow.Id }).first();
    const victimAfter = await ResourceModel.where({ Id: victimRow.Id }).first();

    expect(attackerAfter).to.be.undefined;   // attacker deleted their own row
    expect(victimAfter).to.be.not.undefined; // victim's row survives
    expect(victimAfter!.Value).to.eq('victim');
  });
});
