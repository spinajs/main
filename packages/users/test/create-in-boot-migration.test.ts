import { DI } from '@spinajs/di';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { Migration, Orm, OrmMigration, OrmMigrationGuard, OrmMigrator } from '@spinajs/orm';
import { DefaultQueueService } from '@spinajs/queue';
import { PasswordService } from '@spinajs/authn/contracts';
import { DEFAULT_THROTTLE, FakeBackoffThrottle, MemorySecretStore, MemorySessionIssuer } from '@spinajs/authn-testing';
import { Argon2PasswordHasher, LocalPasswordPolicy, LocalPasswordService } from '@spinajs/authn-local';

import { NO_PASSWORD, User, UserIdentityStore, UserPasswordStore } from '../src/index.js';
import { create } from '../src/actions.js';
import { bootUsersDb, registerUsersTestHost, removeDatabaseFiles, useDatabaseFiles } from './support/users-db.js';

const SEED_TIMEOUT_MS = 10_000;

/** The real password flow over the users stores, so the seed writes through UserPasswordStore as an app's does. */
async function localPasswords(): Promise<LocalPasswordService> {
  const hasher = new Argon2PasswordHasher({});
  await hasher.resolve();
  return new LocalPasswordService({
    identities: new UserIdentityStore(),
    passwords: new UserPasswordStore(),
    sessions: new MemorySessionIssuer(),
    throttle: new FakeBackoffThrottle(DEFAULT_THROTTLE),
    tokens: null,
    secrets: new MemorySecretStore(),
    mailer: null,
    sinks: [],
    hasher,
    policy: new LocalPasswordPolicy({}),
  });
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// The database is a file, so migrate-up and the application boot after it are separate Orms on one database.
describe('create() from a migration seed', function () {
  this.timeout(60000);

  const passwords = () => localPasswords();
  let seed: typeof OrmMigration;
  let seeds = 0;

  before(() => {
    registerUsersTestHost();
    DI.register(passwords).as(PasswordService);

    // Registered here, not at load time: every users suite boots the same migration registry.
    class SeedUserAtBoot_2099_01_01_00_00_00 extends OrmMigration {
      public async up(): Promise<void> {}
      public async down(): Promise<void> {}
      public async data(): Promise<void> {
        seeds++;
        await create({ Email: 'boot-seed@spinajs.pl', Login: 'boot-seed', Password: 'passw0rd123' }, ['user']);
      }
    }
    Migration('default')(SeedUserAtBoot_2099_01_01_00_00_00);
    seed = SeedUserAtBoot_2099_01_01_00_00_00;
  });

  after(async () => {
    DI.unregister(seed);
    DI.unregister(PasswordService, passwords);
    sinon.restore();
    await DI.get(Orm)?.dispose();
    // Drops a resolve left pending by a deadlocked seed too, which uncaching would keep.
    DI.clearCache();
    removeDatabaseFiles();
  });

  // MUST RUN FIRST: the next test boots the application on the database this one migrates.
  it('migrate-up runs the seed, which creates a user with a password', async () => {
    sinon.stub(DefaultQueueService.prototype, 'emit').resolves(undefined);

    // bootUsersDb runs migrateTestDatabase(), whose data phase runs the seed.
    await within(bootUsersDb(useDatabaseFiles), SEED_TIMEOUT_MS, 'migrate-up and its seeds');

    expect(seeds).to.eq(1);
    const u = await User.query().whereLogin('boot-seed').firstOrFail();
    expect(u.Email).to.eq('boot-seed@spinajs.pl');
    expect(u.Password).to.not.eq(NO_PASSWORD);
  });

  it('an application boot afterwards runs no seed and finds the seeded user', async () => {
    await DI.get(Orm)?.dispose();
    DI.uncache(Orm);
    DI.uncache(OrmMigrator);
    DI.uncache(OrmMigrationGuard);

    await DI.resolve(Orm);

    expect(seeds, 'the application boot ran a seed').to.eq(1);
    expect((await User.query().whereLogin('boot-seed').firstOrFail()).Password).to.not.eq(NO_PASSWORD);
  });
});
