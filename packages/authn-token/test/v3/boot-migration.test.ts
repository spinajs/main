import 'mocha';
import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Migration, Orm, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { migrateTestDatabase } from '@spinajs/orm/testing';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';
import { IdentityStore, TokenService } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef, TokenCreateResult } from '@spinajs/authn/contracts';
import { FakeIdentityStore } from '@spinajs/authn-testing';

import { V3DbConfiguration, insertUserRow, shutdownV3Db, uncacheOwn } from './db.js';
import { registerAuthnSchema } from '../db-common.js';
import { DbTokenService, TokenOwnerResolver, UsersTableTokenOwnerResolver } from '../../src/service/index.js';

const SEED_TIMEOUT_MS = 10_000;
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

function uncacheTokenServices(): void {
  DI.uncache(IdentityStore);
  DI.uncache(BootSeedIdentityStore);
  DI.uncache(DbTokenService);
  DI.uncache(TokenService);
  DI.uncache(UsersTableTokenOwnerResolver);
  DI.uncache(TokenOwnerResolver);
}

// What a users seed does through PasswordService: the TokenService is resolved and used in a migration seed. The
// database is a file, so migrate-up and the application boot after it are separate Orms on one database.
describe('the TokenService in a migration seed', function () {
  this.timeout(30000);

  const ctx = (): AuthnContext => ({ now: new Date(), purpose: 'request' });
  let created: TokenCreateResult | undefined;
  let seeds = 0;
  let seed: typeof OrmMigration;
  let dir = '';

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spinajs-token-seed-'));
    V3DbConfiguration.Filename = path.join(dir, 'token-seed.sqlite');

    DI.setESMModuleSupport();
    uncacheOwn();

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
        seeds++;
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
    uncacheTokenServices();
    await shutdownV3Db();
    // Drops a resolve left pending by a deadlocked seed too, which uncaching would keep.
    DI.clearCache();
    V3DbConfiguration.Filename = ':memory:';
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // MUST RUN FIRST: the next test boots the application on the database this one migrates.
  it('migrate-up runs the seed, which creates a token for a user row through the TokenService', async () => {
    await within(migrateTestDatabase(), SEED_TIMEOUT_MS, 'migrate-up and its seeds');

    expect(seeds).to.equal(1);
    expect(created?.ok, 'the seed created its token').to.equal(true);
  });

  it('an application boot afterwards runs no seed, and the seeded token validates', async () => {
    await DI.get(Orm)?.dispose();
    uncacheOwn();
    uncacheTokenServices();
    await DI.resolve(Configuration);

    await DI.resolve(Orm);

    expect(seeds, 'the application boot ran a seed').to.equal(1);
    (DI.resolve(IdentityStore) as BootSeedIdentityStore).add({ id: OWNER.id, login: 'boot-seed' });
    const tokens = await DI.resolve(TokenService);
    const validation = await tokens.validate((created as Extract<TokenCreateResult, { ok: true }>).plaintext, ctx());
    expect(validation.ok).to.equal(true);
  });
});
