import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Migration, Orm, OrmMigration, OrmMigrator } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { IdentityStore, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, TokenCreateResult } from '@spinajs/authn/contracts';
import { FakeIdentityStore } from '@spinajs/authn-testing';

import { V3DbConfiguration, insertUserRow, shutdownV3Db } from './db.js';
import { registerAuthnSchema } from '../db-common.js';
import { DbTokenService, TokenOwnerResolver, UsersTableTokenOwnerResolver } from '../../src/service/index.js';

const BOOT_TIMEOUT_MS = 10_000;
const DAY_MS = 86_400_000;
const OWNER: IdentityRef = { type: 'user', id: '6f1d3a52-6f0e-4c1b-9a43-3f6b2c9e0d11' };

class BootSeedIdentityStore extends FakeIdentityStore {}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// What a users seed does through PasswordService: the TokenService is resolved and used while OrmMigrator runs the migrations.
describe('the TokenService in a boot migration', function () {
  this.timeout(30000);

  const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'request' });
  let created: TokenCreateResult | undefined;
  let seed: typeof OrmMigration;

  before(async () => {
    DI.setESMModuleSupport();
    DI.uncache(OrmMigrator);
    DI.uncache(Orm);
    DI.uncache(Configuration);
    DI.uncache(V3DbConfiguration);
    DI.uncache('orm-driver-sqlite');
    DI.uncache(SqliteOrmDriver);

    DI.register(V3DbConfiguration).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(BootSeedIdentityStore).as(IdentityStore);
    registerAuthnSchema();
    await DI.resolve(Configuration);

    // Registered here, not at load time: the other suites boot the same migration registry.
    class SeedTokenAtBoot_2099_01_01_00_00_00 extends OrmMigration {
      public async up(connection: OrmDriver): Promise<void> {
        await insertUserRow(OWNER.id, connection);
      }
      public async down(): Promise<void> {}
      public async data(): Promise<void> {
        const tokens = await DI.resolve(TokenService);
        created = await tokens.create(OWNER, { name: 'boot-seed', kind: 'pat', expiresAt: new Date(Date.now() + DAY_MS) }, ctx());
      }
    }
    Migration('default')(SeedTokenAtBoot_2099_01_01_00_00_00);
    seed = SeedTokenAtBoot_2099_01_01_00_00_00;
  });

  after(async () => {
    DI.unregister(seed);
    DI.unregister(BootSeedIdentityStore);
    DI.uncache(BootSeedIdentityStore);
    DI.uncache(IdentityStore);
    DI.uncache(DbTokenService);
    DI.uncache(TokenService);
    DI.uncache(UsersTableTokenOwnerResolver);
    DI.uncache(TokenOwnerResolver);
    DI.uncache(OrmMigrator);
    await shutdownV3Db();
    // Drops a resolve left pending by a deadlocked boot too, which uncaching would keep.
    DI.clearCache();
  });

  it('creates a token for a user row while OrmMigrator runs the boot migrations', async () => {
    await within(Promise.resolve(DI.resolve(OrmMigrator)), BOOT_TIMEOUT_MS, 'the boot migration pass');

    expect(created?.ok, 'the seed created its token').to.equal(true);
    (DI.resolve(IdentityStore) as BootSeedIdentityStore).add({ id: OWNER.id, login: 'boot-seed' });
    const tokens = await DI.resolve(TokenService);
    const validation = await tokens.validate((created as Extract<TokenCreateResult, { ok: true }>).plaintext, ctx());
    expect(validation.ok).to.equal(true);
  });
});
