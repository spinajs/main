import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { HostLog } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { MigrationTransactionMode, OrmDriver } from '@spinajs/orm';

import { AuthzRbacDropUserRole_2026_10_01_00_02_00, AuthzRbacUserRoles_2026_10_01_00_01_00, readVersion } from '../../src/index.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from '../support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const DROP = 'AuthzRbacDropUserRole_2026_10_01_00_02_00';
const COPY = 'AuthzRbacUserRoles_2026_10_01_00_01_00';
const INITIAL = 'AuthzRbac_2026_10_01_00_00_00';
const HOUR = 3600 * 1000;

const timestampOf = (migration: string): string => /_(\d{4}(?:_\d{2}){5})$/.exec(migration)?.[1] ?? '';

/** The 2.x users tables (RBACInitial_2022_06_28_01_13_00): indexes, a unique column, a boolean CHECK and a foreign key from users_metadata. */
async function createUsers(driver: OrmDriver, role: string | null = 'Role'): Promise<void> {
  await driver.schema().createTable('users', (table) => {
    table.int('Id').primaryKey().autoIncrement();
    table.string('Uuid', 36).notNull();
    table.string('Email', 64).unique().notNull();
    table.string('Login', 64).notNull();
    if (role) table.string(role, 256).notNull();
    table.boolean('IsActive').notNull().default().value(0);
    table.dateTime('CreatedAt').notNull().default().dateTime();
  });

  await driver.schema().createTable('users_metadata', (table) => {
    table.int('Id').primaryKey().autoIncrement();
    table.string('Key', 255).notNull();
    table.text('Value');
    table.int('user_id').notNull();
    table.foreignKey('user_id').references('users', 'Id').cascade();
  });

  await driver.index().unique().table('users').name('user_uuid_idx').columns(['Uuid']);
  await driver.index().unique().table('users').name('user_login_idx').columns(['Login']);
}

const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;

async function seedUsers(driver: OrmDriver, roles: string[], role: string | null = 'Role', from = 0): Promise<string[]> {
  const uuids: string[] = [];
  for (let i = from; i < from + roles.length; i++) {
    const row: Record<string, unknown> = { Uuid: uuid(i + 1), Email: `u${i + 1}@example.test`, Login: `u${i + 1}`, IsActive: i % 2 };
    if (role) row[role] = roles[i - from];
    await driver.insert().into('users').values(row);
    uuids.push(uuid(i + 1));
  }
  return uuids;
}

// 0, 1 and 2 roles (the plan)
const ROLES = ['', 'admin', 'user, admin.users'];
const [A, B, C] = [uuid(1), uuid(2), uuid(3)];

async function columnNames(driver: OrmDriver): Promise<string[]> {
  return ((await driver.tableInfo('users')) ?? []).map((c) => c.Name);
}

async function otherColumns(driver: OrmDriver): Promise<Record<string, unknown>[]> {
  return (await driver.select().columns(['Id', 'Uuid', 'Email', 'Login', 'IsActive', 'CreatedAt']).from('users').orderBy('Id')) as Record<string, unknown>[];
}

async function rolesByUser(driver: OrmDriver, column = 'Role'): Promise<Record<string, string>> {
  const rows = (await driver.select().columns(['Uuid', column]).from('users')) as Record<string, any>[];
  return Object.fromEntries(rows.map((r) => [r.Uuid, r[column]]));
}

async function indexNames(db: TestDb): Promise<string[]> {
  const rows = db.kind === 'postgres' ? await rawQuery(db.driver, `SELECT indexname AS name FROM pg_indexes WHERE tablename = 'users' AND schemaname = current_schema()`) : await rawQuery(db.driver, `PRAGMA index_list('users')`);
  return rows.map((r: any) => r.name).sort();
}

const pairs = (rows: Record<string, any>[]) => rows.map((r) => `${r.subject_type}:${r.subject_id}=${r.role}`).sort();

async function assignments(driver: OrmDriver): Promise<Record<string, any>[]> {
  return (await driver.select().from('authz_assignment')) as Record<string, any>[];
}

async function grant(driver: OrmDriver, row: Record<string, unknown>): Promise<void> {
  await driver
    .insert()
    .into('authz_assignment')
    .values({ id: `g-${Math.random().toString(16).slice(2)}`, subject_type: 'user', created_at: new Date(), ...row });
}

const asSet = (roles: string) =>
  [
    ...new Set(
      roles
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r),
    ),
  ].sort();

function recordingLog(lines: string[]): HostLog {
  return {
    error: (m: string) => lines.push(`error ${m}`),
    warn: (m: string) => lines.push(`warn ${m}`),
    info: (m: string) => lines.push(`info ${m}`),
    debug: () => {},
  };
}

class RecordingDrop extends AuthzRbacDropUserRole_2026_10_01_00_02_00 {
  public lines: string[] = [];
  protected log = recordingLog(this.lines);
}

class SmallPages extends AuthzRbacDropUserRole_2026_10_01_00_02_00 {
  public pages = 0;
  protected readonly pageSize = 2;

  protected async page(connection: OrmDriver, idColumn: string, roleColumn: string, after: unknown): Promise<Record<string, unknown>[]> {
    this.pages++;
    return super.page(connection, idColumn, roleColumn, after);
  }
}

/** Records the Postgres locks its own backend holds on `users` when the check reads the first page. */
class LockProbe extends AuthzRbacDropUserRole_2026_10_01_00_02_00 {
  public modes: string[] | undefined;

  protected async page(connection: OrmDriver, idColumn: string, roleColumn: string, after: unknown): Promise<Record<string, unknown>[]> {
    this.modes ??= (await rawQuery(connection, `SELECT mode FROM pg_locks WHERE relation = 'users'::regclass AND pid = pg_backend_pid() AND granted`)).map((r: any) => r.mode);
    return super.page(connection, idColumn, roleColumn, after);
  }
}

for (const kind of DB_KINDS) {
  describe(`${DROP} (${kind})`, function () {
    this.timeout(60000);

    let db: TestDb | undefined;

    async function boot(ctx: Mocha.Context, config: Record<string, string> = {}): Promise<TestDb> {
      db = await bootDb(ctx, kind, 'user_role_drop', { migrate: false });
      const configuration = await db.container.resolve(Configuration);
      for (const [key, value] of Object.entries(config)) configuration.set(key, value);
      return db;
    }

    /** `up(name)` runs only that migration, so the tables come first. */
    async function copy(db: TestDb): Promise<void> {
      await db.orm.Migration.up(INITIAL);
      await db.orm.Migration.up(COPY);
    }

    async function status(db: TestDb, name = DROP) {
      return (await db.orm.Migration.status()).find((s) => s.name === name)!;
    }

    afterEach(async () => {
      await db?.dispose();
      db = undefined;
    });

    it('is registered from the package root and runs right after the copy', async function () {
      const db = await boot(this);
      const names = db.orm.Migrations.map((m) => m.name);
      expect(names).to.include(DROP);
      // The registry keeps import order; the runner orders by the name's timestamp, then the name.
      const order = [...names].sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)) || a.localeCompare(b));
      expect(order.indexOf(DROP)).to.eq(order.indexOf(COPY) + 1);
      expect((await status(db)).pending).to.eq(true);
    });

    it('copies and drops users.Role in one service run, leaving the other columns, their data and indexes', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.driver.insert().into('users_metadata').values({ Key: 'theme', Value: 'dark', user_id: 2 });

      if (kind === 'postgres') {
        const cols = await rawQuery(db.driver, `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND table_schema = current_schema()`);
        expect(cols.map((c: any) => c.column_name)).to.include('Role');
      }

      const data = await otherColumns(db.driver);
      const indexes = await indexNames(db);
      expect(indexes).to.include.members(['user_uuid_idx', 'user_login_idx']);

      await db.orm.Migration.up();

      expect((await status(db, COPY)).pending).to.eq(false);
      expect((await status(db)).pending).to.eq(false);
      expect((await status(db)).failed).to.eq(false);

      expect(await columnNames(db.driver)).to.deep.eq(['Id', 'Uuid', 'Email', 'Login', 'IsActive', 'CreatedAt']);
      expect(pairs(await assignments(db.driver))).to.deep.eq([`user:${B}=admin`, `user:${C}=admin.users`, `user:${C}=user`]);
      expect(await otherColumns(db.driver)).to.deep.eq(data);
      expect(await indexNames(db)).to.deep.eq(indexes);
      expect(await db.driver.select().columns(['Key', 'Value', 'user_id']).from('users_metadata')).to.deep.eq([{ Key: 'theme', Value: 'dark', user_id: 2 }]);
      // the drop touches no assignment, so only the copy bumped the version
      expect(await readVersion(db.driver, 'root')).to.eq('1');
    });

    it('copies and drops in the run transaction (PerRun)', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      const options = db.driver.Options;
      options.Migration = { ...options.Migration, Transaction: { Mode: MigrationTransactionMode.PerRun } };

      await db.orm.Migration.up();

      expect((await status(db)).pending).to.eq(false);
      expect(await columnNames(db.driver)).to.not.include('Role');
      expect(pairs(await assignments(db.driver))).to.have.length(3);
    });

    it('refuses when a copied role has no assignment, and changes nothing', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await copy(db);
      await db.driver.del().from('authz_assignment').where({ subject_id: C, role: 'user' });
      const before = await assignments(db.driver);

      await expect(db.orm.Migration.up()).to.be.rejectedWith(`${DROP}: the users.Role copy is incomplete: 1 user/role pair(s) have no live $global assignment (user:${C} user); nothing was changed. Grant the missing roles through AuthzAdmin.assign or authz:assign (this also renews an expired grant), or remove them from users.Role if they were revoked on purpose; if every user is listed, check authz.rbac.migration.idColumn and authz.rbac.migration.roleColumn. Then run orm.Migration.resolve('${DROP}', 'rolled-back') and migrate again`);

      expect((await status(db)).failed).to.eq(true);
      expect(await columnNames(db.driver)).to.include('Role');
      expect(await rolesByUser(db.driver)).to.deep.eq({ [A]: '', [B]: 'admin', [C]: 'user, admin.users' });
      expect(await assignments(db.driver)).to.deep.eq(before);
    });

    it('refuses for users seeded after the copy, counting every pair and naming the first five', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await copy(db);
      await seedUsers(db.driver, ['x', 'y, z', 'p,q,r', 's'], 'Role', 3);

      const err = await db.orm.Migration.up().then(
        () => undefined,
        (e: Error) => e,
      );

      expect(err?.message).to.contain('7 user/role pair(s) have no live $global assignment');
      expect(err?.message).to.contain(`(user:${uuid(4)} x, user:${uuid(5)} y, user:${uuid(5)} z, user:${uuid(6)} p, user:${uuid(6)} q, …)`);
      expect(await columnNames(db.driver)).to.include('Role');
    });

    it('counts an expired assignment as missing and a future expiry as present', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await copy(db);
      await db.driver
        .update()
        .in('authz_assignment')
        .update({ expires_at: new Date(Date.now() - HOUR) })
        .where({ subject_id: B, role: 'admin' });
      await db.driver
        .update()
        .in('authz_assignment')
        .update({ expires_at: new Date(Date.now() + HOUR) })
        .where({ subject_id: C, role: 'user' });

      await expect(db.orm.Migration.up()).to.be.rejectedWith(new RegExp(`1 user/role pair\\(s\\) have no live \\$global assignment \\(user:${B} admin\\)`));
      expect(await columnNames(db.driver)).to.include('Role');
    });

    it('accepts roles granted with another source and ignores grants outside $global principals', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up(INITIAL);
      // the copy skips B's admin since this grant exists; C gets an extra role the column never had
      await grant(db.driver, { subject_id: B, role: 'admin', source: 'db' });
      await grant(db.driver, { subject_id: C, role: 'editor', source: 'db' });

      await db.orm.Migration.up();

      expect((await status(db)).pending).to.eq(false);
      expect(await columnNames(db.driver)).to.not.include('Role');
    });

    it('does not count a scoped grant, a subject-set grant or another subject type as the copy', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ['admin']);
      await db.orm.Migration.up(INITIAL);
      await grant(db.driver, { subject_id: A, role: 'admin', scope_type: 'project', scope_id: 'p1' });
      await grant(db.driver, { subject_id: A, role: 'admin', subject_role: 'member' });
      await grant(db.driver, { subject_type: 'group', subject_id: A, role: 'admin' });
      // only these three hold the role, so the guard must find it missing
      await db.orm.Migration.up(COPY);
      await db.driver.del().from('authz_assignment').where({ source: 'users.Role' });

      await expect(db.orm.Migration.up()).to.be.rejectedWith(`(user:${A} admin)`);
    });

    it('walks the users in pages', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ['a', 'b', 'c', 'd', 'e']);
      await copy(db);
      await db.driver
        .del()
        .from('authz_assignment')
        .where({ subject_id: uuid(5) });

      const refused = new SmallPages();
      await expect(refused.up(db.driver)).to.be.rejectedWith(`(user:${uuid(5)} e)`);
      expect(refused.pages).to.eq(3);

      await grant(db.driver, { subject_id: uuid(5), role: 'e' });
      const migration = new SmallPages();
      await migration.up(db.driver);
      expect(await columnNames(db.driver)).to.not.include('Role');

      await migration.down(db.driver);
      expect(await rolesByUser(db.driver)).to.deep.eq({ [uuid(1)]: 'a', [uuid(2)]: 'b', [uuid(3)]: 'c', [uuid(4)]: 'd', [uuid(5)]: 'e' });
    });

    /** Users keyed by a nullable `ExternalId`: four rows with a blank id hold roles, two hold none. */
    async function blankIdUsers(ctx: Mocha.Context): Promise<TestDb> {
      const db = await boot(ctx, { 'authz.rbac.migration.idColumn': 'ExternalId' });
      await db.driver.schema().createTable('users', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('ExternalId', 36);
        table.string('Role', 256).notNull();
      });
      const rows: [string | null, string][] = [
        [null, 'admin'],
        ['', 'admin'],
        ['  ', 'admin'],
        ['x1', 'admin'],
        [null, 'admin'],
        [null, ''],
        ['', ' , '],
      ];
      for (const [ExternalId, Role] of rows) {
        await db.driver.insert().into('users').values({ ExternalId, Role });
      }
      await copy(db);
      return db;
    }

    it('skips rows whose id is null or empty, warning once about those that hold roles, and drops the column', async function () {
      const db = await blankIdUsers(this);

      const migration = new RecordingDrop();
      await migration.up(db.driver);

      expect(migration.lines).to.deep.eq([`warn ${DROP}: skipped 4 users row(s) with roles whose ExternalId is null or empty; their roles were not copied and are lost with the dropped column`]);
      expect(await columnNames(db.driver)).to.deep.eq(['Id', 'ExternalId']);
    });

    it('says the skipped roles were not copied, and nothing about losing them, when it refuses', async function () {
      const db = await blankIdUsers(this);
      await db.driver.del().from('authz_assignment').where({ subject_id: 'x1' });

      const migration = new RecordingDrop();
      await expect(migration.up(db.driver)).to.be.rejectedWith('(user:x1 admin)');

      expect(migration.lines).to.deep.eq([`warn ${DROP}: skipped 4 users row(s) with roles whose ExternalId is null or empty; their roles were not copied`]);
      expect(await columnNames(db.driver)).to.include('Role');
    });

    it('refuses when the id column is not unique, since the keyset walk skips tied rows', async function () {
      const db = await boot(this, { 'authz.rbac.migration.idColumn': 'Ext' });
      await db.driver.schema().createTable('users', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Ext', 36).notNull();
        table.string('Role', 256).notNull();
      });
      for (const [Ext, Role] of [
        ['a', 'r1'],
        ['a', 'r2'],
        ['a', 'r3'],
        ['b', 'r4'],
      ]) {
        await db.driver.insert().into('users').values({ Ext, Role });
      }
      await copy(db);

      // page size 2: the second page starts after 'a', so one 'a' row is never read
      await expect(new SmallPages().up(db.driver)).to.be.rejectedWith(`${DROP}: cannot check the users.Role copy: the walk by users.Ext read 3 of 4 rows, so users.Ext (authz.rbac.migration.idColumn) is not unique; nothing was changed. Point authz.rbac.migration.idColumn at a unique column, then run orm.Migration.resolve('${DROP}', 'rolled-back') and migrate again`);
      expect(await columnNames(db.driver)).to.include('Role');
    });

    if (kind === 'postgres') {
      it('holds a SHARE lock on users while it checks, so no writer slips in before the drop', async function () {
        const db = await boot(this);
        await createUsers(db.driver);
        await seedUsers(db.driver, ROLES);
        await copy(db);

        const migration = new LockProbe();
        await migration.up(db.driver);

        expect(migration.modes).to.include('ShareLock');
        expect(await columnNames(db.driver)).to.not.include('Role');
      });
    }

    it('reads authz.rbac.migration.idColumn and roleColumn (Id / Roles)', async function () {
      const db = await boot(this, { 'authz.rbac.migration.roleColumn': 'Roles', 'authz.rbac.migration.idColumn': 'Id' });
      await createUsers(db.driver, 'Roles');
      await seedUsers(db.driver, ROLES, 'Roles');

      await db.orm.Migration.up();
      expect(await columnNames(db.driver)).to.not.include('Roles');
      expect(pairs(await assignments(db.driver))).to.deep.eq(['user:2=admin', 'user:3=admin.users', 'user:3=user']);

      await db.orm.Migration.down(DROP);
      expect(await rolesByUser(db.driver, 'Roles')).to.deep.eq({ [A]: '', [B]: 'admin', [C]: 'admin.users,user' });
    });

    it('refuses when a filled users table has the role column but not the id column', async function () {
      const db = await boot(this);
      await db.driver.schema().createTable('users', (table) => {
        table.int('Id').primaryKey().autoIncrement();
        table.string('Role', 256).notNull();
      });
      await db.driver.insert().into('users').values({ Role: 'admin' });
      await copy(db);

      await expect(new AuthzRbacDropUserRole_2026_10_01_00_02_00().up(db.driver)).to.be.rejectedWith(/cannot check the users\.Role copy: table users has no column Uuid \(authz\.rbac\.migration\.idColumn\)/);
      expect(await columnNames(db.driver)).to.include('Role');
    });

    it('is a no-op with one info line when there is no users table, up and down', async function () {
      const db = await boot(this);

      await db.orm.Migration.up();
      expect((await status(db)).pending).to.eq(false);
      await db.orm.Migration.down(DROP);
      expect((await status(db)).pending).to.eq(true);
      expect(await db.driver.tableInfo('users')).to.not.be.ok;

      const migration = new RecordingDrop();
      await migration.up(db.driver);
      await migration.down(db.driver);
      expect(migration.lines).to.deep.eq([`info ${DROP}: no table users; nothing dropped`, `info ${DROP}: no table users; nothing re-added`]);
    });

    it('warns and keeps the table when a filled users table lacks the role column (info when empty)', async function () {
      const db = await boot(this);
      await createUsers(db.driver, null);
      await db.orm.Migration.up(INITIAL);

      const empty = new RecordingDrop();
      await empty.up(db.driver);
      expect(empty.lines).to.have.length(1);
      expect(empty.lines[0]).to.match(/^info .*table users has no column Role \(authz\.rbac\.migration\.roleColumn\); its columns are .*; nothing dropped$/);

      await seedUsers(db.driver, ['x'], null);
      const filled = new RecordingDrop();
      await filled.up(db.driver);
      expect(filled.lines).to.have.length(1);
      expect(filled.lines[0]).to.match(/^warn .*table users has no column Role \(authz\.rbac\.migration\.roleColumn\); its columns are Id, Uuid, Email, Login, IsActive, CreatedAt; nothing dropped/);
      expect(await columnNames(db.driver)).to.deep.eq(['Id', 'Uuid', 'Email', 'Login', 'IsActive', 'CreatedAt']);
    });

    it('fails the migration when the users probe throws', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await copy(db);

      const original = db.driver.tableInfo;
      db.driver.tableInfo = (name: string, schema?: string) => (name === 'users' ? Promise.reject(new Error('probe failed')) : original.call(db.driver, name, schema));
      try {
        await expect(db.orm.Migration.up()).to.be.rejectedWith(/probe failed/);
      } finally {
        db.driver.tableInfo = original;
      }

      expect((await status(db)).failed).to.eq(true);
      expect(await columnNames(db.driver)).to.include('Role');
    });

    it('down() through the service re-adds the column NOT NULL default empty, filled from live $global user grants', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ['', 'admin', 'user, admin.users', 'viewer']);
      const declared = (await db.driver.tableInfo('users')).find((c) => c.Name === 'Role')!;
      await db.orm.Migration.up();

      const D = uuid(4);
      await grant(db.driver, { subject_id: B, role: 'old', expires_at: new Date(Date.now() - HOUR) });
      await grant(db.driver, { subject_id: B, role: 'temp', expires_at: new Date(Date.now() + HOUR) });
      await grant(db.driver, { subject_id: B, role: 'editor', source: 'db' });
      // code-unit order puts 'Zed' first; a Postgres en_US index scan returns it last
      await grant(db.driver, { subject_id: B, role: 'Zed' });
      await grant(db.driver, { subject_id: C, role: 'owner', scope_type: 'project', scope_id: 'p1' });
      await grant(db.driver, { subject_id: C, role: 'member', subject_role: 'staff' });
      await grant(db.driver, { subject_type: 'group', subject_id: A, role: 'admin' });
      // D's only role has expired
      await db.driver
        .update()
        .in('authz_assignment')
        .update({ expires_at: new Date(Date.now() - HOUR) })
        .where({ subject_id: D, role: 'viewer' });
      const granted = await assignments(db.driver);

      const undone = await db.orm.Migration.down(DROP);

      expect(undone.map((m) => m.constructor)).to.deep.eq([AuthzRbacDropUserRole_2026_10_01_00_02_00]);
      expect((await status(db)).pending).to.eq(true);
      expect((await status(db, COPY)).pending).to.eq(false);

      const role = (await db.driver.tableInfo('users')).find((c) => c.Name === 'Role')!;
      expect(role.Nullable).to.eq(false);
      expect(String(role.DefaultValue)).to.match(/^''/);
      if (kind === 'postgres') {
        const [col] = await rawQuery(db.driver, `SELECT data_type, character_maximum_length AS len FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'Role' AND table_schema = current_schema()`);
        expect([col.data_type, Number(col.len)]).to.deep.eq(['character varying', 256]);
      } else {
        // the sqlite driver renders every string column as TEXT, the 2.x one included
        expect(role.NativeType).to.eq(declared.NativeType);
      }

      expect(await rolesByUser(db.driver)).to.deep.eq({ [A]: '', [B]: 'Zed,admin,editor,temp', [C]: 'admin.users,user', [D]: '' });
      expect(await assignments(db.driver)).to.deep.eq(granted);

      // 2.x inserts without a role still work
      await db.driver
        .insert()
        .into('users')
        .values({ Uuid: uuid(9), Email: 'u9@example.test', Login: 'u9' });
      expect((await rolesByUser(db.driver))[uuid(9)]).to.eq('');
    });

    it('round trip: up then down gives back the original role sets', async function () {
      const db = await boot(this);
      const original = ['', 'admin', 'user, admin.users', 'admin,admin, ', ' , ,', 'b,a,c'];
      await createUsers(db.driver);
      const uuids = await seedUsers(db.driver, original);

      await db.orm.Migration.up();
      await db.orm.Migration.down(DROP);

      const back = await rolesByUser(db.driver);
      expect(uuids.map((u) => asSet(back[u]))).to.deep.eq(original.map(asSet));

      // and the drop runs again over the rebuilt column
      await db.orm.Migration.up();
      expect(await columnNames(db.driver)).to.not.include('Role');
    });

    it('down() leaves an existing role column alone', async function () {
      const db = await boot(this);
      await createUsers(db.driver);
      await seedUsers(db.driver, ROLES);
      await db.orm.Migration.up(INITIAL);
      await grant(db.driver, { subject_id: A, role: 'admin' });

      await new AuthzRbacDropUserRole_2026_10_01_00_02_00().down(db.driver);

      expect(await rolesByUser(db.driver)).to.deep.eq({ [A]: '', [B]: 'admin', [C]: 'user, admin.users' });
    });

    it('is exported next to the copy migration', () => {
      expect(AuthzRbacUserRoles_2026_10_01_00_01_00).to.be.a('function');
      expect(AuthzRbacDropUserRole_2026_10_01_00_02_00.name).to.eq(DROP);
    });
  });
}
