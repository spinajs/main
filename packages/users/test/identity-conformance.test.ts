import { DI } from '@spinajs/di';
import { Orm, OrmDriver, QueryContext } from '@spinajs/orm';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import { randomBytes } from 'node:crypto';
import { runIdentityStoreConformance } from '@spinajs/authn-testing';
import type { IdentitySubject } from '@spinajs/authn-testing';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { DateTime } from 'luxon';

import { USER_COMMON_METADATA, User, UserIdentityStore, UserPasswordStore } from '../src/index.js';
import { bootUsersDb, registerUsersTestHost, seedUser, storedUser } from './support/users-db.js';

type Flags = { active?: boolean; banned?: boolean; deleted?: boolean; invitePending?: boolean };

async function setFlags(ref: IdentityRef, flags: Flags): Promise<void> {
  const driver = User.query().Driver;
  const u = await storedUser(ref.id);

  if (flags.active !== undefined) {
    await driver.update().in('users').update({ IsActive: flags.active }).where('Uuid', ref.id);
  }
  if (flags.deleted !== undefined) {
    await driver
      .update()
      .in('users')
      .update({ DeletedAt: flags.deleted ? DateTime.now().toSQL({ includeOffset: false }) : null })
      .where('Uuid', ref.id);
  }
  for (const [flag, key] of [
    ['banned', USER_COMMON_METADATA.USER_BAN_IS_BANNED],
    ['invitePending', USER_COMMON_METADATA.USER_INVITE_PENDING],
  ] as const) {
    if (flags[flag] === true) {
      u.Metadata[key] = true;
      await u.Metadata.update();
    } else if (flags[flag] === false) {
      await u.Metadata.delete(key);
    }
  }
}

function subject(): IdentitySubject {
  const ids: number[] = [];

  return {
    store: new UserIdentityStore(),
    passwords: new UserPasswordStore(),
    jit: false,
    seed: {
      async user(spec) {
        const { user, ref } = await seedUser({ login: spec.login, ...(spec.email ? { email: spec.email } : {}) });
        ids.push(user.Id);
        if (spec.status) {
          await setFlags(ref, spec.status);
        }
        return ref;
      },
      setStatus: setFlags,
    },
    async dispose() {
      const driver = User.query().Driver;
      for (const id of ids) {
        await driver.del().from('users_metadata').where('user_id', id);
        await driver.del().from('users').where('Id', id);
      }
    },
  };
}

/**
 * The kit's identity store conformance over the real stores and the users test database. The Orm boots once;
 * each case gets its own rows, removed by `dispose`.
 */
describe('UserIdentityStore + UserPasswordStore conformance (sqlite)', function () {
  this.timeout(60000);

  before(async () => {
    registerUsersTestHost();
    await bootUsersDb();
  });

  after(() => {
    DI.clearCache();
  });

  runIdentityStoreConformance(subject);
});

const PG = { Host: '127.0.0.1', Port: 15432, User: 'postgres', Password: 'postgres' };

async function pgAdmin(sql: string): Promise<void> {
  const driver = await DI.child().resolve<OrmDriver>(PostgresOrmDriver, [{ Name: 'c1-pg-admin', Driver: 'orm-driver-postgres', ...PG, Database: 'postgres', Pool: { Max: 1, AcquireTimeout: 15000 } }]);
  await driver.connect();
  try {
    await (driver as unknown as { executeOnDb(s: string, b: unknown[], c: QueryContext): Promise<unknown> }).executeOnDb(sql, [], QueryContext.Schema);
  } finally {
    await driver.disconnect();
  }
}

/**
 * The same over the whole users schema (users, authz-rbac and the test migrations) on the orm-postgres docker fixture,
 * in a database made for the run. Skipped when the server cannot be reached (C1_REQUIRE_DB=1 fails instead).
 */
describe('UserIdentityStore + UserPasswordStore conformance (postgres)', function () {
  this.timeout(120000);

  const database = `c1_users_${randomBytes(4).toString('hex')}`;
  let created = false;

  before(async function () {
    registerUsersTestHost();
    DI.register(PostgresOrmDriver).as('orm-driver-postgres');

    try {
      await pgAdmin(`CREATE DATABASE ${database}`);
      created = true;
    } catch (err) {
      if (process.env.C1_REQUIRE_DB === '1') {
        throw err;
      }
      console.warn(`      postgres is unreachable (${(err as Error).name}), suite skipped (set C1_REQUIRE_DB=1 to fail instead)`);
      this.skip();
    }

    // Edits the resolved configuration: a Configuration class registered here would outlive the suite (DI keeps the
    // last registration), and every later suite would boot on this database.
    await bootUsersDb((config) => {
      const connections = config.get<Record<string, unknown>[]>('db.Connections');
      config.set('db.DefaultConnection', 'users-pg');
      config.set(
        'db.Connections',
        connections.map((c) => (c.Name === 'sqlite' ? { Driver: 'orm-driver-postgres', Name: 'users-pg', ...PG, Database: database, Migration: c.Migration } : c)),
      );
    });

    if (User.query().Driver.Options.Driver !== 'orm-driver-postgres') {
      throw new Error(`the users connection is ${User.query().Driver.Options.Driver}, not postgres`);
    }
  });

  after(async () => {
    try {
      if (DI.has(Orm)) {
        await DI.get(Orm)!.dispose();
      }
    } finally {
      DI.clearCache();
      if (created) {
        await pgAdmin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      }
    }
  });

  runIdentityStoreConformance(subject);
});
