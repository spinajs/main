import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { HostLog } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { MigrationTransactionMode, OrmDriver } from '@spinajs/orm';

import { AuthzRbacUserRoles_2026_10_01_00_01_00, USER_ROLES_DEFAULT_ID_COLUMN, USER_ROLES_DEFAULT_ROLE_COLUMN, readVersion, toDate, USER_ROLES_SOURCE } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const MIGRATION = 'AuthzRbacUserRoles_2026_10_01_00_01_00';
const INITIAL = 'AuthzRbac_2026_10_01_00_00_00';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface UsersShape {
  role?: string | null;
}

/** The 2.x `users` table (RBACInitial_2022_06_28_01_13_00), trimmed to the columns that matter here. */
async function createUsers(driver: OrmDriver, shape: UsersShape = {}): Promise<void> {
  const role = shape.role === undefined ? 'Role' : shape.role;
  await driver.schema().createTable('users', (table) => {
    table.int('Id').primaryKey().autoIncrement();
    table.string('Uuid', 36).notNull();
    table.string('Email', 64).notNull();
    if (role) table.string(role, 256).notNull();
  });
}

async function seedUsers(driver: OrmDriver, roles: string[], roleColumn = 'Role'): Promise<void> {
  for (let i = 0; i < roles.length; i++) {
    await driver
      .insert()
      .into('users')
      .values({ Uuid: UUIDS[i], Email: `u${i + 1}@example.test`, [roleColumn]: roles[i] });
  }
}

async function assignments(driver: OrmDriver): Promise<Record<string, any>[]> {
  const rows = (await driver.select().from('authz_assignment')) as Record<string, any>[];
  return rows.sort((a, b) => `${a.subject_id}/${a.role}`.localeCompare(`${b.subject_id}/${b.role}`));
}

const pairs = (rows: Record<string, any>[]) => rows.map((r) => `${r.subject_type}:${r.subject_id}=${r.role}`).sort();

async function status(db: TestDb) {
  return (await db.orm.Migration.status()).find((s) => s.name === MIGRATION)!;
}

/** Captures what the migration logs. */
function recordingLog(lines: string[]): HostLog {
  return {
    error: (m: string) => lines.push(`error ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    info: (m: string) => lines.push(`info ${m}`),
    debug: () => {},
  };
}

class RecordingMigration extends AuthzRbacUserRoles_2026_10_01_00_01_00 {
  public lines: string[] = [];
  protected log = recordingLog(this.lines);
}

class SmallPages extends AuthzRbacUserRoles_2026_10_01_00_01_00 {
  public pages = 0;
  public seen: unknown[] = [];
  protected readonly pageSize = 2;
  protected readonly insertBatch = 3;

  protected async page(connection: OrmDriver, idColumn: string, roleColumn: string, after: unknown): Promise<Record<string, unknown>[]> {
    this.pages++;
    const users = await super.page(connection, idColumn, roleColumn, after);
    this.seen.push(...users.map((u) => u[idColumn]));
    return users;
  }
}

// 0, 1 and 2 roles (the plan), then a duplicate with a trailing comma, then separators only
const ROLES = ['', 'admin', 'user, admin.users', 'admin,admin, ', ' , ,'];
// Uuid order differs from Id order, so a walk keyed by the wrong column shows
const UUIDS = ['c', 'a', 'e', 'b', 'd'].map((p, i) => `${p}0000000-0000-4000-8000-00000000000${i + 1}`);
const EXPECTED = [`user:${UUIDS[1]}=admin`, `user:${UUIDS[2]}=admin.users`, `user:${UUIDS[2]}=user`, `user:${UUIDS[3]}=admin`].sort();
const EXPECTED_BY_ID = ['user:2=admin', 'user:3=admin.users', 'user:3=user', 'user:4=admin'];

async function pgColumns(driver: OrmDriver): Promise<string[]> {
  const cols = await rawQuery(driver, `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND table_schema = current_schema()`);
  return cols.map((c: any) => c.column_name);
}

for (const kind of DB_KINDS) {
  describe(`${MIGRATION} (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb | undefined;

    async function boot(ctx: Mocha.Context, config: Record<string, string> = {}): Promise<TestDb> {
      db = await bootDb(ctx, kind, 'user_roles', { migrate: false });
      const configuration = await db.container.resolve(Configuration);
      for (const [key, value] of Object.entries(config)) configuration.set(key, value);
      return db;
    }

    afterEach(async () => {
      await db?.dispose();
      db = undefined;
    });

    it('is registered from the package root, keyed by Uuid and Role by default', async function () {
      const db = await boot(this);
      expect(db.orm.Migrations.map((m) => m.type)).to.include(AuthzRbacUserRoles_2026_10_01_00_01_00);
      expect((await status(db)).pending).to.eq(true);
      expect([USER_ROLES_DEFAULT_ID_COLUMN, USER_ROLES_DEFAULT_ROLE_COLUMN]).to.deep.eq(['Uuid', 'Role']);
    });

    it('copies each users.Role entry into a $global assignment of user:<Uuid> with the exact columns', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);

      if (kind === 'postgres') {
        // mixed-case columns only resolve when every statement quotes them
        expect(await pgColumns(db.driver)).to.include.members(['Uuid', 'Role']);
      }

      const before = new Date();
      await db.orm.Migration.up();
      const after = new Date();

      expect((await status(db)).pending).to.eq(false);
      expect((await status(db)).failed).to.eq(false);

      const rows = await assignments(db.driver);
      expect(pairs(rows)).to.deep.eq(EXPECTED);
      expect(new Set(rows.map((r) => r.id)).size).to.eq(rows.length);

      for (const r of rows) {
        expect(r.id).to.match(UUID);
        expect(r).to.deep.include({ subject_type: 'user', subject_role: '', scope_type: '$global', scope_id: '', tags: '', source: 'users.Role', expires_at: null, granted_by: null });
        expect(r.subject_key).to.eq(`user:${r.subject_id}`);
        const created = toDate(r.created_at)!.getTime();
        // SQLite keeps milliseconds; Postgres TIMESTAMP keeps microseconds
        expect(created).to.be.within(before.getTime() - 1, after.getTime() + 1);
      }

      expect(await readVersion(db.driver, 'root')).to.eq('1');
    });

    it('a second up() inserts nothing, fails nothing and does not bump the version', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up();
      const first = await assignments(db.driver);

      await new AuthzRbacUserRoles_2026_10_01_00_01_00().up(db.driver);

      expect(await assignments(db.driver)).to.deep.eq(first);
      expect(await readVersion(db.driver, 'root')).to.eq('1');
    });

    it('keeps an identical assignment granted earlier and adds the rest', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up(INITIAL);
      await db.driver
        .insert()
        .into('authz_assignment')
        .values({ id: 'granted-earlier', subject_type: 'user', subject_id: UUIDS[1], subject_key: `user:${UUIDS[1]}`, role: 'admin', source: 'db', granted_by: 'user:9', created_at: new Date('2025-01-01T00:00:00Z') });

      await db.orm.Migration.up();

      const rows = await assignments(db.driver);
      expect(pairs(rows)).to.deep.eq(EXPECTED);
      const kept = rows.find((r) => r.subject_id === UUIDS[1])!;
      expect(kept).to.deep.include({ id: 'granted-earlier', source: 'db', granted_by: 'user:9' });
      expect(await readVersion(db.driver, 'root')).to.eq('1');
    });

    it('does not bump the version when every role is already granted', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ['', 'admin']);
      await db.orm.Migration.up(INITIAL);
      await db.driver
        .insert()
        .into('authz_assignment')
        .values({ id: 'granted-earlier', subject_type: 'user', subject_id: UUIDS[1], subject_key: `user:${UUIDS[1]}`, role: 'admin', created_at: new Date() });

      await db.orm.Migration.up();

      expect(pairs(await assignments(db.driver))).to.deep.eq([`user:${UUIDS[1]}=admin`]);
      expect(await readVersion(db.driver, 'root')).to.eq('0');
    });

    it('reads authz.rbac.migration.idColumn and roleColumn (Id / Roles)', async function () {
      const db = await boot(this, { 'authz.rbac.migration.roleColumn': 'Roles', 'authz.rbac.migration.idColumn': 'Id' });
      await createUsers(db.driver, { role: 'Roles' });
      await seedUsers(db.driver, ROLES, 'Roles');

      if (kind === 'postgres') {
        expect(await pgColumns(db.driver)).to.include.members(['Id', 'Roles']);
      }

      await db.orm.Migration.up();

      expect(pairs(await assignments(db.driver))).to.deep.eq(EXPECTED_BY_ID);
    });

    it('matches the configured column names ignoring case', async function () {
      const db = await boot(this, { 'authz.rbac.migration.roleColumn': 'role', 'authz.rbac.migration.idColumn': 'uuid' });
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);

      await db.orm.Migration.up();

      expect(pairs(await assignments(db.driver))).to.deep.eq(EXPECTED);
    });

    it('walks string ids (Uuid) across pages in id order', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up(INITIAL);

      const migration = new SmallPages();
      await migration.up(db.driver);

      expect(pairs(await assignments(db.driver))).to.deep.eq(EXPECTED);
      // 5 users in pages of 2; the short third page ends the walk
      expect(migration.pages).to.eq(3);
      expect(migration.seen).to.deep.eq([...UUIDS].sort());
      expect(await readVersion(db.driver, 'root')).to.eq('1');
    });

    it('walks integer ids (Id) across pages', async function () {
      const db = await boot(this, { 'authz.rbac.migration.idColumn': 'Id' });
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up(INITIAL);

      const migration = new SmallPages();
      await migration.up(db.driver);

      expect(pairs(await assignments(db.driver))).to.deep.eq(EXPECTED_BY_ID);
      expect(migration.pages).to.eq(3);
      expect(migration.seen.map(Number)).to.deep.eq([1, 2, 3, 4, 5]);
    });

    it('skips rows whose id is null or empty, with one warn line', async function () {
      const db = await boot(this, { 'authz.rbac.migration.idColumn': 'ExternalId' });
      await db.driver.schema().createTable('users', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('ExternalId', 36);
        table.string('Role', 256).notNull();
      });
      for (const ExternalId of [null, '', '  ', 'x1', null]) {
        await db.driver.insert().into('users').values({ ExternalId, Role: 'admin' });
      }
      await db.orm.Migration.up(INITIAL);

      const migration = new RecordingMigration();
      await migration.up(db.driver);

      expect(pairs(await assignments(db.driver))).to.deep.eq(['user:x1=admin']);
      expect(migration.lines).to.have.length(1);
      expect(migration.lines[0]).to.match(/^warn .*skipped 4 users row\(s\) whose ExternalId is null or empty/);
    });

    it('is a no-op with one info line when there is no users table', async function () {
      const db = await boot(this);

      await db.orm.Migration.up();

      expect((await status(db)).pending).to.eq(false);
      expect(await assignments(db.driver)).to.deep.eq([]);
      expect(await readVersion(db.driver, 'root')).to.eq('0');

      const migration = new RecordingMigration();
      await migration.up(db.driver);
      expect(migration.lines).to.deep.eq(['info AuthzRbacUserRoles_2026_10_01_00_01_00: no table users; no roles copied']);
    });

    it('warns, naming table, column and key, when a filled users table lacks the role column', async function () {
      const db = await boot(this);
      await createUsers(db.driver, { role: null });
      await db.driver.insert().into('users').values({ Uuid: UUIDS[0], Email: 'u1@example.test' });

      await db.orm.Migration.up();

      expect((await status(db)).pending).to.eq(false);
      expect(await assignments(db.driver)).to.deep.eq([]);

      const migration = new RecordingMigration();
      await migration.up(db.driver);
      expect(migration.lines).to.have.length(1);
      expect(migration.lines[0]).to.match(/^warn .*table users has no column Role \(authz\.rbac\.migration\.roleColumn\); its columns are Id, Uuid, Email;/);
    });

    it('logs at info when an empty users table lacks the role column', async function () {
      const db = await boot(this);
      await createUsers(db.driver, { role: null });
      await db.orm.Migration.up(INITIAL);

      const migration = new RecordingMigration();
      await migration.up(db.driver);
      expect(migration.lines).to.have.length(1);
      expect(migration.lines[0]).to.match(/^info .*has no column Role/);
    });

    it('fails the migration when the users probe throws', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);

      const original = db.driver.tableInfo;
      db.driver.tableInfo = (name: string, schema?: string) => (name === 'users' ? Promise.reject(new Error('probe failed')) : original.call(db.driver, name, schema));
      try {
        await expect(db.orm.Migration.up()).to.be.rejectedWith(/probe failed/);
      } finally {
        db.driver.tableInfo = original;
      }

      expect((await status(db)).failed).to.eq(true);
      expect(await assignments(db.driver)).to.deep.eq([]);
    });

    it('runs inside the transaction already in scope', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up(INITIAL);

      let inside: string[] = [];
      await expect(
        db.driver.transaction(async () => {
          await new AuthzRbacUserRoles_2026_10_01_00_01_00().up(db.driver);
          inside = pairs(await assignments(db.driver));
          throw new Error('roll back');
        }),
      ).to.be.rejectedWith('roll back');

      expect(inside).to.deep.eq(EXPECTED);
      expect(await assignments(db.driver)).to.deep.eq([]);
      expect(await readVersion(db.driver, 'root')).to.eq('0');
    });

    it('copies under the service in PerRun transaction mode', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      const options = db.driver.Options;
      options.Migration = { ...options.Migration, Transaction: { Mode: MigrationTransactionMode.PerRun } };

      await db.orm.Migration.up();

      expect((await status(db)).pending).to.eq(false);
      expect(pairs(await assignments(db.driver))).to.deep.eq(EXPECTED);
      expect(await readVersion(db.driver, 'root')).to.eq('1');
    });

    it('down() through the migration service deletes only its own rows', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up();
      await db.driver
        .insert()
        .into('authz_assignment')
        .values({ id: 'granted-later', subject_type: 'user', subject_id: UUIDS[1], subject_key: `user:${UUIDS[1]}`, role: 'editor', source: 'db', created_at: new Date() });

      const undone = await db.orm.Migration.down(MIGRATION);

      expect(undone.map((m) => m.constructor)).to.deep.eq([AuthzRbacUserRoles_2026_10_01_00_01_00]);
      expect(pairs(await assignments(db.driver))).to.deep.eq([`user:${UUIDS[1]}=editor`]);
      expect((await status(db)).pending).to.eq(true);
      expect(await readVersion(db.driver, 'root')).to.eq('2');
      expect(USER_ROLES_SOURCE).to.eq('users.Role');
    });
  });
}
