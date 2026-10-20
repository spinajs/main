import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { expect } from 'chai';
import { randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { OrmDriver, QueryContext } from '@spinajs/orm';
import { MsSqlOrmDriver } from '@spinajs/orm-mssql';
import { MySqlOrmDriver } from '@spinajs/orm-mysql';
import { PostgresOrmDriver } from '@spinajs/orm-postgres';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { NO_PASSWORD, UserPasswordStore } from '../src/index.js';
import { TestConfiguration, dir } from './common.test.js';

const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$AbCdEf';
const OTHER = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$GhIjKl';

interface Server {
  readonly type: Class<OrmDriver>;
  readonly registered: string;
  readonly connection: Record<string, unknown>;
  /** The database the admin connection uses; undefined: none. */
  readonly adminDatabase?: string;
}

// The docker fixtures of the orm-* packages' own tests.
const SERVERS: Record<string, Server> = {
  postgres: { type: PostgresOrmDriver, registered: 'orm-driver-postgres', connection: { Host: '127.0.0.1', Port: Number(process.env.ORM_TEST_POSTGRES_PORT ?? 15432), User: 'postgres', Password: 'postgres' }, adminDatabase: 'postgres' },
  mysql: { type: MySqlOrmDriver, registered: 'orm-driver-mysql', connection: { Host: '127.0.0.1', Port: 13306, User: 'root', Password: 'root' } },
  mssql: { type: MsSqlOrmDriver, registered: 'orm-driver-mssql', connection: { Host: '127.0.0.1', User: 'sa', Password: 'yourStrong(!)Password', Options: { TrustServerCertificate: true } }, adminDatabase: 'master' },
};

async function connect(server: Server, database: string | undefined): Promise<OrmDriver> {
  const driver = await DI.child().resolve<OrmDriver>(server.type, [{ Name: `c1-${server.registered}`, Driver: server.registered, ...server.connection, Database: database, Pool: { Max: 4, AcquireTimeout: 15000 } }]);
  await driver.connect();
  return driver;
}

function run(driver: OrmDriver, sql: string, context = QueryContext.Schema): Promise<unknown> {
  return (driver as unknown as { executeOnDb(s: string, b: unknown[], c: QueryContext): Promise<unknown> }).executeOnDb(sql, [], context);
}

async function admin<T>(server: Server, work: (d: OrmDriver) => Promise<T>): Promise<T> {
  const driver = await connect(server, server.adminDatabase);
  try {
    return await work(driver);
  } finally {
    await driver.disconnect();
  }
}

/**
 * UserPasswordStore's SQL on the real servers, over a `users` table made by the ORM's schema builder as the users
 * migration makes it. A server that cannot be reached skips its suite (C1_REQUIRE_DB=1 fails instead).
 */
for (const [kind, server] of Object.entries(SERVERS)) {
  describe(`UserPasswordStore on ${kind}`, function () {
    this.timeout(120000);

    const database = `c1_users_${randomBytes(4).toString('hex')}`;
    let driver: OrmDriver | undefined;
    let store: UserPasswordStore;

    const seed = async (password: string): Promise<IdentityRef> => {
      const uuid = uuidv4();
      await driver!.insert().into('users').values({ Uuid: uuid, Password: password });
      return { type: 'user', id: uuid };
    };

    before(async function () {
      DI.register(TestConfiguration).as(Configuration);
      await DI.resolve(Configuration, [null, null, [dir('./config')]]);

      try {
        await admin(server, (d) => run(d, `CREATE DATABASE ${database}`));
      } catch (err) {
        if (process.env.C1_REQUIRE_DB === '1') {
          throw err;
        }
        console.warn(`      ${kind} is unreachable (${(err as Error).name}), suite skipped (set C1_REQUIRE_DB=1 to fail instead)`);
        this.skip();
      }

      driver = await connect(server, database);
      await driver.schema().createTable('users', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Uuid', 36).notNull();
        table.string('Password', 128).notNull();
      });
      store = new UserPasswordStore({ driver });
    });

    after(async () => {
      if (driver) {
        await driver.disconnect();
        await admin(server, (d) => run(d, kind === 'postgres' ? `DROP DATABASE IF EXISTS ${database} WITH (FORCE)` : `DROP DATABASE ${database}`));
      }
      DI.clearCache();
    });

    it('compares the expected value byte for byte: not by case, not ignoring trailing spaces', async () => {
      const ref = await seed(HASH);

      expect(await store.set(ref, OTHER, HASH.toLowerCase())).to.eq(false);
      expect(await store.set(ref, OTHER, HASH.toUpperCase())).to.eq(false);
      expect(await store.set(ref, OTHER, `${HASH} `)).to.eq(false);
      expect(await store.get(ref)).to.eq(HASH);
      expect(await store.set(ref, OTHER, HASH)).to.eq(true);
      expect(await store.get(ref)).to.eq(OTHER);
    });

    it('reports a matched row for an UPDATE that writes the stored value again (CLIENT_FOUND_ROWS on MySQL)', async () => {
      const ref = await seed(HASH);

      const result = (await driver!.update().in('users').update({ Password: HASH }).where('Uuid', ref.id)) as { RowsAffected: number };

      expect(result.RowsAffected).to.eq(1);
    });

    it('answers a conditional write of the stored value from the stored value', async () => {
      const ref = await seed(HASH);

      expect(await store.set(ref, HASH, HASH)).to.eq(true);
      expect(await store.set(ref, OTHER, OTHER)).to.eq(false);
      expect(await store.set(ref, HASH)).to.eq(true);
    });

    it('writes with null expected only over a no-password state', async () => {
      const none = await seed(NO_PASSWORD);
      const empty = await seed('');
      const held = await seed(HASH);

      expect(await store.set(none, OTHER, null)).to.eq(true);
      expect(await store.set(empty, OTHER, null)).to.eq(true);
      expect(await store.set(held, OTHER, null)).to.eq(false);
      expect(await store.get(held)).to.eq(HASH);
    });

    it('lets exactly one of eight parallel conditional writers win', async () => {
      const ref = await seed(HASH);
      const hashes = Array.from({ length: 8 }, (_, i) => `${OTHER}${i}`);

      const wrote = await Promise.all(hashes.map((h) => store.set(ref, h, HASH)));

      expect(wrote.filter(Boolean)).to.have.lengthOf(1);
      expect(await store.get(ref)).to.eq(hashes[wrote.indexOf(true)]);
    });
  });
}
