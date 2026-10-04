import { FakeClock, runAuthnBehaviour } from '@spinajs/authn-testing';
import type { Harness, LegacyUser, SecretRowView } from '@spinajs/authn-testing';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument, InvalidOperation, InvalidOption, UnexpectedServerError } from '@spinajs/exceptions';
import { OrmDriver, OrmMigration, QueryContext } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import { createHash, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import { AuthnFromUserMetadata_2026_10_02_00_01_00, DbSecretStore, decryptMfaSecret, fromUtcColumn, mfaKeyFrom } from '../src/index.js';
import type { LegacyMetadata } from '../src/migrations/AuthnFromUserMetadata_2026_10_02_00_01_00.js';
import { bootDb, DB_KINDS, rawQuery, TestDb } from './support/db.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const MIGRATION = 'AuthnFromUserMetadata_2026_10_02_00_01_00';
const KEY = randomBytes(32).toString('base64url');
const T0 = new Date('2026-06-01T10:00:00.000Z');

/** The `users` / `users_metadata` DDL of 2.x `RBACInitial_2022_06_28_01_13_00`; undecorated, test boots only. */
class LegacyUsers_2022_06_28_01_13_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('users', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Uuid', 36).notNull();
      table.string('Email', 64).unique().notNull();
      table.string('Password', 128).notNull();
      table.string('Login', 64).notNull();
      table.string('Role', 256).notNull();
      table.boolean('IsActive').notNull().default().value(0);
      table.dateTime('CreatedAt').notNull().default().dateTime();
      table.dateTime('DeletedAt');
      table.dateTime('LastLoginAt');
    });

    await connection.schema().createTable('users_metadata', (table) => {
      table.int('Id').primaryKey().autoIncrement();
      table.string('Key', 255).notNull();
      table.enum('Type', ['number', 'float', 'string', 'json', 'boolean', 'datetime']).notNull();
      table.text('Value');
      table.int('user_id').notNull();
      table.foreignKey('user_id').references('users', 'Id').cascade();
    });

    await connection.index().unique().table('users').name('user_uuid_idx').columns(['Uuid']);
    await connection.index().unique().table('users_metadata').name('owner_user_meta_key_idx').columns(['user_id', 'Key']);
    await connection.index().unique().table('users').name('user_login_idx').columns(['Login']);
  }

  public async down(): Promise<void> {}
}

/** Skips the first insert into `table`, so the count check sees one row fewer than it counted. */
class SkipOneInsert extends AuthnFromUserMetadata_2026_10_02_00_01_00 {
  private skipped = false;

  constructor(private readonly table: string) {
    super();
  }

  protected override async insertRow(connection: OrmDriver, table: string, values: Record<string, unknown>): Promise<void> {
    if (table === this.table && !this.skipped) {
      this.skipped = true;
      return;
    }
    await super.insertRow(connection, table, values);
  }
}

class CapturingMigration extends AuthnFromUserMetadata_2026_10_02_00_01_00 {
  public readonly warnings: string[] = [];
  public readonly infos: string[] = [];

  protected override warn(message: string): void {
    this.warnings.push(message);
  }

  protected override info(message: string): void {
    this.infos.push(message);
  }
}

/** Loses the first user's `key` value in the carry's own read, as a parse slip would; the census still sees it. */
class LosesOneValue extends AuthnFromUserMetadata_2026_10_02_00_01_00 {
  constructor(private readonly key: string) {
    super();
  }

  protected override async readMetadata(connection: OrmDriver): Promise<LegacyMetadata> {
    const read = await super.readMetadata(connection);
    const owner = [...read.byUser.values()].find((values) => values.has(this.key));
    owner?.delete(this.key);
    return read;
  }
}

/** Leaves one security row out of the delete, as a row written by 2.x after the scan would be. */
class MissesOneRow extends AuthnFromUserMetadata_2026_10_02_00_01_00 {
  protected override async readMetadata(connection: OrmDriver): Promise<LegacyMetadata> {
    const read = await super.readMetadata(connection);
    return { ...read, securityIds: read.securityIds.slice(1) };
  }
}

/** Fails the metadata insert the way a driver does: the error keeps the statement's bindings. */
class FailingRestore extends AuthnFromUserMetadata_2026_10_02_00_01_00 {
  protected override async insertRow(connection: OrmDriver, table: string, values: Record<string, unknown>): Promise<void> {
    if (table === 'users_metadata') {
      throw Object.assign(new Error(`insert failed with ${JSON.stringify(values)}`), { bindings: Object.values(values), inner: { bindings: Object.values(values) } });
    }
    await super.insertRow(connection, table, values);
  }
}

const TABLES_TO_CLEAN = ['users_metadata', 'users', 'authn_secret', 'authn_mfa', 'authn_recovery_code'];

async function clean(db: TestDb): Promise<void> {
  for (const table of TABLES_TO_CLEAN) {
    await rawQuery(db.driver, `DELETE FROM ${table}`, [], QueryContext.Delete);
  }
}

async function setKey(db: TestDb, secret: string | null): Promise<void> {
  (await db.container.resolve(Configuration)).set('authn.mfa.encryptionKey.secret', secret);
}

async function userId(db: TestDb, uuid: string): Promise<number> {
  const rows = (await db.driver.select().from('users').where('Uuid', uuid)) as Record<string, unknown>[];
  expect(rows, `user ${uuid}`).to.have.length(1);
  return Number(rows[0].Id);
}

async function seedLegacy(db: TestDb, users: readonly LegacyUser[]): Promise<void> {
  for (const u of users) {
    await db.driver
      .insert()
      .into('users')
      .values({ Uuid: u.Uuid, Email: u.Email, Login: u.Login, Password: 'x'.repeat(20), Role: 'user', IsActive: u.IsActive });
    const id = await userId(db, u.Uuid);
    for (const m of u.metadata) {
      await db.driver.insert().into('users_metadata').values({ Key: m.Key, Type: m.Type, Value: m.Value, user_id: id });
    }
  }
}

interface MetaRow {
  Key: string;
  Type: string;
  Value: string | null;
}

async function metadataOf(db: TestDb, uuid: string): Promise<MetaRow[]> {
  const id = await userId(db, uuid);
  const rows = (await db.driver.select().from('users_metadata').where('user_id', id)) as Record<string, unknown>[];
  return rows.map((r) => ({ Key: String(r.Key), Type: String(r.Type), Value: r.Value === null ? null : String(r.Value) })).sort((a, b) => (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0));
}

async function metadataKeys(db: TestDb, uuid: string): Promise<string[]> {
  return (await metadataOf(db, uuid)).map((r) => r.Key);
}

async function secretRows(db: TestDb): Promise<SecretRowView[]> {
  const rows = (await rawQuery(db.driver, 'SELECT identity, purpose, secret_hash, CAST(expires_at AS TEXT) AS expires_text, CAST(used_at AS TEXT) AS used_text, CAST(created_at AS TEXT) AS created_text FROM authn_secret ORDER BY id')) as Record<string, string | null>[];
  return rows.map((r) => ({ identity: r.identity!, purpose: r.purpose!, secret_hash: r.secret_hash!, expires_at: fromUtcColumn(r.expires_text)!, created_at: fromUtcColumn(r.created_text)!, used_at: fromUtcColumn(r.used_text) ?? null }));
}

interface MfaRowText {
  identity: string;
  step: string;
  secret_enc: string;
  key_id: string;
  confirmed_text: string | null;
  created_text: string;
  last_step: unknown;
}

async function mfaRows(db: TestDb): Promise<MfaRowText[]> {
  return (await rawQuery(db.driver, 'SELECT identity, step, secret_enc, key_id, CAST(confirmed_at AS TEXT) AS confirmed_text, CAST(created_at AS TEXT) AS created_text, last_step FROM authn_mfa ORDER BY identity, step')) as MfaRowText[];
}

/** Every row of the tables the migration touches, for "nothing changed" checks. */
async function snapshot(db: TestDb): Promise<string> {
  const all: Record<string, unknown> = {};
  for (const [table, order] of [
    ['users_metadata', '"Id"'],
    ['users', '"Id"'],
    ['authn_secret', 'id'],
    ['authn_mfa', 'identity, step'],
    ['authn_recovery_code', 'id'],
  ]) {
    all[table] = await rawQuery(db.driver, `SELECT * FROM ${table} ORDER BY ${order}`);
  }
  return JSON.stringify(all);
}

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const ms = (d: Date | null | undefined): number | undefined => d?.getTime();
const timeText = (text: string | null): number | undefined => ms(fromUtcColumn(text));

const run = (db: TestDb, m = new AuthnFromUserMetadata_2026_10_02_00_01_00()) => m.up(db.driver);
const undo = (db: TestDb, m = new AuthnFromUserMetadata_2026_10_02_00_01_00()) => m.down(db.driver);

const SECRET_A = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const SECRET_B = 'KRUGS4ZANFZSAYJAONSWG4TFOQQQ====';
const SECRET_C = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RESET_A = '0f7c2e4a-1b3d-4e5f-8a9b-0c1d2e3f4a5b';
const INVITE_C = '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d';

const uuid = (n: number) => `b0b00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (s: number) => new Date(T0.getTime() + s * 1000).toISOString();
const meta = (Key: string, Value: string | null, Type: MetaRow['Type'] = 'string') => ({ Key, Type, Value } as LegacyUser['metadata'][number]);

const ALICE: LegacyUser = {
  Uuid: uuid(1),
  Email: 'alice@example.test',
  Login: 'alice',
  IsActive: true,
  metadata: [meta('2fa:token', SECRET_A), meta('2fa:enabled', 'true', 'boolean'), meta('2fa:otp', `otpauth://totp/ACME:alice?issuer=ACME&secret=${SECRET_A}&algorithm=SHA1&digits=6&period=30`), meta('user:2fa:token', 'LEGACYSECRETAAAA'), meta('user:login:attempts', '3', 'number'), meta('user:login:locked_until', at(600), 'datetime'), meta('user:pwd_reset:token', RESET_A), meta('user:pwd_reset:start_date', at(-60), 'datetime'), meta('user:pwd_reset:wait_time', '3600', 'number'), meta('user:pwd:reset', 'true', 'boolean'), meta('user:phone', '+48 600 000 001'), meta('user:ban:is_banned', 'false', 'boolean')],
};

const BOB: LegacyUser = {
  Uuid: uuid(2),
  Email: 'bob@example.test',
  Login: 'bob',
  IsActive: true,
  metadata: [meta('2fa:token', SECRET_B), meta('2fa:enabled', 'false', 'boolean'), meta('2fa', 'kept'), meta('user:2fa', 'kept'), meta('user:pwdXreset:token', 'kept'), meta('user:pwd:resetx', 'kept')],
};

const CAROL: LegacyUser = {
  Uuid: uuid(3),
  Email: 'carol@example.test',
  Login: 'carol',
  IsActive: false,
  metadata: [meta('2fa:token', SECRET_C), meta('2fa:enabled', '1', 'number'), meta('user:invite:pending', 'true', 'json'), meta('user:pwd_reset:token', INVITE_C), meta('user:pwd_reset:start_date', at(-30), 'datetime'), meta('user:pwd_reset:wait_time', '900', 'number')],
};

const DAVE: LegacyUser = { Uuid: uuid(4), Email: 'dave@example.test', Login: 'dave', IsActive: true, metadata: [meta('user:phone', '+48 600 000 004')] };

const USERS = [ALICE, BOB, CAROL, DAVE];
const KEPT: Record<string, string[]> = {
  [ALICE.Uuid]: ['user:ban:is_banned', 'user:phone'],
  [BOB.Uuid]: ['2fa', 'user:2fa', 'user:pwd:resetx', 'user:pwdXreset:token'],
  [CAROL.Uuid]: ['user:invite:pending'],
  [DAVE.Uuid]: ['user:phone'],
};
const TOTP: [LegacyUser, string, boolean][] = [
  [ALICE, SECRET_A, true],
  [BOB, SECRET_B, false],
  [CAROL, SECRET_C, true],
];

const legacyUser = (n: number, metadata: LegacyUser['metadata']): LegacyUser => ({ Uuid: uuid(n), Email: `u${n}@example.test`, Login: `u${n}`, IsActive: true, metadata });

type MetaType = LegacyUser['metadata'][number]['Type'];

/** [Type, Value, confirmed]: 2.x `UniversalValueConverter.fromDB`, then truthiness (`Default2FaToken.isEnabled`). */
const ENABLED_FORMS: [MetaType | undefined, string | null, boolean][] = [
  [undefined, null, false],
  ['boolean', 'true', true],
  ['boolean', 'false', false],
  ['boolean', '1', false],
  ['boolean', 'TRUE', false],
  ['boolean', null, false],
  ['number', '1', true],
  ['number', '2', true],
  ['number', '0', false],
  ['number', 'abc', false],
  ['float', '0.5', true],
  ['float', '0', false],
  ['string', 'false', true],
  ['string', '', false],
  ['json', 'true', true],
  ['json', 'false', false],
  ['json', '0', false],
  ['json', '{}', true],
  // 2.x threw on this value; the carry keeps the stronger state
  ['json', 'not json', true],
  ['datetime', '2026-01-01T00:00:00.000Z', true],
];

/** [Type, Value, invite]: 2.x accepted an invite only for a value decoded `=== true`. */
const INVITE_FORMS: [MetaType, string | null, boolean][] = [
  ['boolean', 'true', true],
  ['json', 'true', true],
  ['boolean', 'false', false],
  ['boolean', '1', false],
  ['number', '1', false],
  ['string', 'true', false],
  ['json', '1', false],
  ['json', 'not json', false],
  ['boolean', null, false],
];

const ORPHAN_ID = 999999;

/** users_metadata rows owned by a user id that `users` does not hold, past the foreign key. */
async function insertOrphan(db: TestDb, rows: LegacyUser['metadata']): Promise<void> {
  const insert = async () => {
    for (const m of rows) {
      await db.driver.insert().into('users_metadata').values({ Key: m.Key, Type: m.Type, Value: m.Value, user_id: ORPHAN_ID });
    }
  };
  if (db.kind === 'postgres') {
    await rawQuery(db.driver, 'ALTER TABLE users_metadata DISABLE TRIGGER ALL', [], QueryContext.Schema);
    try {
      await insert();
    } finally {
      await rawQuery(db.driver, 'ALTER TABLE users_metadata ENABLE TRIGGER ALL', [], QueryContext.Schema);
    }
    return;
  }
  const [{ foreign_keys }] = (await rawQuery(db.driver, 'PRAGMA foreign_keys')) as { foreign_keys: number }[];
  await rawQuery(db.driver, 'PRAGMA foreign_keys = OFF', [], QueryContext.Schema);
  try {
    await insert();
  } finally {
    if (foreign_keys) await rawQuery(db.driver, 'PRAGMA foreign_keys = ON', [], QueryContext.Schema);
  }
}

for (const kind of DB_KINDS) {
  describe(`${MIGRATION} (${kind})`, function () {
    this.timeout(120000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'upgrade', { migrations: [LegacyUsers_2022_06_28_01_13_00] });
    });

    after(async () => {
      await db?.dispose();
    });

    it('is registered and ran on startup with nothing to carry', async () => {
      expect(db.orm.Migrations.map((m) => m.type)).to.include(AuthnFromUserMetadata_2026_10_02_00_01_00);
      const status = (await db.orm.Migration.status()).find((s) => s.name === MIGRATION);
      expect(status, 'status entry').to.not.be.undefined;
      expect(status!.pending).to.eq(false);
      expect(status!.failed).to.eq(false);
    });

    runAuthnBehaviour(
      ['A32'],
      async (): Promise<Harness> => {
        await clean(db);
        // No 2.x user of the A32 fixture has a 2fa:token, so the migration must run without the key.
        await setKey(db, null);
        return {
          migration: {
            seedLegacy: (users) => seedLegacy(db, users),
            run: () => run(db),
            secretRows: () => secretRows(db),
            metadataKeys: (u) => metadataKeys(db, u),
          },
          secrets: new DbSecretStore(db.driver),
        };
      },
      { facets: ['A32/migration'], claim: ['A32/migration'], title: `A32 upgrade (${kind})`, timeoutMs: 60000 },
    );

    describe('own cases', () => {
      let clock: FakeClock;

      beforeEach(async () => {
        await clean(db);
        await setKey(db, KEY);
        clock = new FakeClock(T0);
        clock.install();
      });

      afterEach(() => {
        clock.uninstall();
      });

      it('SR-09 TOTP secret is encrypted at rest after the upgrade', async () => {
        await seedLegacy(db, USERS);
        await run(db);

        const key = mfaKeyFrom(KEY);
        const rows = await mfaRows(db);
        expect(rows.map((r) => [r.identity, r.step])).to.deep.eq(TOTP.map(([u]) => [`user:${u.Uuid}`, 'totp']));

        const all = JSON.stringify(await rawQuery(db.driver, 'SELECT * FROM authn_mfa'));
        for (const [, secret] of TOTP) {
          expect(all).to.not.contain(secret);
          expect(all).to.not.contain(secret.toLowerCase());
          expect(all).to.not.contain(secret.replace(/=+$/, ''));
        }

        for (const [u, secret] of TOTP) {
          const r = rows.find((x) => x.identity === `user:${u.Uuid}`)!;
          expect(r.key_id).to.eq(key.keyId);
          expect(r.last_step).to.eq(null);
          expect(decryptMfaSecret(key, `user:${u.Uuid}`, 'totp', r.secret_enc)).to.eq(secret);
          expect(() => decryptMfaSecret(key, `user:${DAVE.Uuid}`, 'totp', r.secret_enc)).to.throw(InvalidArgument);
          expect(() => decryptMfaSecret(mfaKeyFrom(randomBytes(32).toString('hex')), `user:${u.Uuid}`, 'totp', r.secret_enc)).to.throw(InvalidArgument);
        }
      });

      it("confirms a step whose 2fa:enabled 2.x read as true, at the migration's now; others stay unconfirmed", async () => {
        await seedLegacy(db, USERS);
        await run(db);

        const rows = await mfaRows(db);
        for (const [u, , confirmed] of TOTP) {
          const r = rows.find((x) => x.identity === `user:${u.Uuid}`)!;
          expect(timeText(r.created_text), `${u.Login} created_at`).to.eq(T0.getTime());
          expect(timeText(r.confirmed_text), `${u.Login} confirmed_at`).to.eq(confirmed ? T0.getTime() : undefined);
        }
      });

      it('SR-01 no reset token or 2fa secret is left in users_metadata', async () => {
        await seedLegacy(db, USERS);
        await run(db);

        for (const u of USERS) {
          expect(await metadataKeys(db, u.Uuid), u.Login).to.deep.eq([...KEPT[u.Uuid]].sort());
        }
        const left = JSON.stringify(await rawQuery(db.driver, 'SELECT * FROM users_metadata'));
        for (const secret of [SECRET_A, SECRET_B, SECRET_C, RESET_A, INVITE_C, 'LEGACYSECRETAAAA']) {
          expect(left).to.not.contain(secret);
        }
      });

      it('carries resets and invites with their 2.x expiry; a json true user:invite:pending makes an invite', async () => {
        await seedLegacy(db, USERS);
        await run(db);

        const rows = await secretRows(db);
        expect(rows.map((r) => [r.identity, r.purpose, r.secret_hash]).sort()).to.deep.eq(
          [
            [`user:${ALICE.Uuid}`, 'reset', sha256hex(RESET_A)],
            [`user:${CAROL.Uuid}`, 'invite', sha256hex(INVITE_C)],
          ].sort(),
        );
        const alice = rows.find((r) => r.purpose === 'reset')!;
        expect(ms(alice.created_at)).to.eq(T0.getTime() - 60_000);
        expect(ms(alice.expires_at)).to.eq(T0.getTime() + 3_540_000);
        expect(alice.used_at).to.eq(null);

        const store = new DbSecretStore(db.driver);
        expect(await store.redeem({ type: 'user', id: CAROL.Uuid }, 'reset', INVITE_C)).to.eq(false);
        expect(await store.redeem({ type: 'user', id: CAROL.Uuid }, 'invite', INVITE_C)).to.eq(true);
      });

      it('refuses without the key or with an invalid key and changes nothing', async () => {
        await seedLegacy(db, USERS);
        const before = await snapshot(db);

        for (const secret of [null, '', 'not-a-key', randomBytes(16).toString('hex')]) {
          await setKey(db, secret);
          const err = await run(db).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(err, String(secret)).to.be.instanceOf(InvalidOption);
          expect((err as Error).message)
            .to.contain('3 user(s) have a 2fa:token')
            .and.contain('authn.mfa.encryptionKey.secret');
          expect(await snapshot(db), String(secret)).to.eq(before);
        }
      });

      it('runs without the key when no user has a 2fa:token', async () => {
        await seedLegacy(db, [{ ...ALICE, metadata: ALICE.metadata.filter((m) => !m.Key.startsWith('2fa:')) }, DAVE]);
        await setKey(db, null);

        await run(db);

        expect(await mfaRows(db)).to.deep.eq([]);
        expect((await secretRows(db)).map((r) => r.identity)).to.deep.eq([`user:${ALICE.Uuid}`]);
        expect(await metadataKeys(db, ALICE.Uuid)).to.deep.eq(KEPT[ALICE.Uuid]);
      });

      for (const table of ['authn_secret', 'authn_mfa']) {
        it(`throws on a planted count mismatch in ${table} and rolls everything back`, async () => {
          await seedLegacy(db, USERS);
          const before = await snapshot(db);

          await expect(run(db, new SkipOneInsert(table))).to.be.rejectedWith(/count/);

          expect(await snapshot(db)).to.eq(before);
        });
      }

      it('down() restores 2fa:token and 2fa:enabled, removes the carried rows and logs the users', async () => {
        await seedLegacy(db, USERS);
        await run(db);
        const alice = `user:${ALICE.Uuid}`;
        const others = [
          ['authn_mfa', { identity: alice, step: 'webauthn', secret_enc: 'v1.a.b.c', key_id: 'k', created_at: '2026-06-01 10:00:00.000' }],
          ['authn_mfa', { identity: 'agent:a1', step: 'totp', secret_enc: 'v1.a.b.c', key_id: 'k', created_at: '2026-06-01 10:00:00.000' }],
          ['authn_recovery_code', { id: 'rc-alice', identity: alice, code_hash: 'a'.repeat(64) }],
          ['authn_recovery_code', { id: 'rc-agent', identity: 'agent:a1', code_hash: 'b'.repeat(64) }],
          ['authn_secret', { id: 's-email', identity: alice, purpose: 'email-verify', secret_hash: 'c'.repeat(64), expires_at: '2026-06-02 10:00:00.000', created_at: '2026-06-01 10:00:00.000' }],
          ['authn_secret', { id: 's-key', identity: 'key:k1', purpose: 'reset', secret_hash: 'd'.repeat(64), expires_at: '2026-06-02 10:00:00.000', created_at: '2026-06-01 10:00:00.000' }],
        ] as const;
        for (const [table, values] of others) {
          await db.driver.insert().into(table).values(values);
        }

        const m = new CapturingMigration();
        await undo(db, m);

        for (const [u, secret, confirmed] of TOTP) {
          const rows = (await metadataOf(db, u.Uuid)).filter((r) => r.Key.startsWith('2fa:'));
          const expected = [{ Key: '2fa:token', Type: 'string', Value: secret }, ...(confirmed ? [{ Key: '2fa:enabled', Type: 'boolean', Value: 'true' }] : [])];
          expect(rows, u.Login).to.deep.eq(expected.sort((a, b) => (a.Key < b.Key ? -1 : 1)));
        }
        expect((await mfaRows(db)).map((r) => [r.identity, r.step])).to.deep.eq([
          ['agent:a1', 'totp'],
          [alice, 'webauthn'],
        ]);
        expect(((await rawQuery(db.driver, 'SELECT id FROM authn_recovery_code')) as { id: string }[]).map((r) => r.id)).to.deep.eq(['rc-agent']);
        expect(((await rawQuery(db.driver, 'SELECT id FROM authn_secret ORDER BY id')) as { id: string }[]).map((r) => r.id)).to.deep.eq(['s-email', 's-key']);

        const log = m.warnings.join('\n');
        for (const u of [ALICE, CAROL]) {
          expect(log).to.contain(u.Uuid);
          expect(log).to.contain(u.Email);
        }
        expect(log).to.not.contain(BOB.Email);
        expect(log).to.not.contain(RESET_A);
      });

      it('down() refuses without the key or under another key and changes nothing', async () => {
        await seedLegacy(db, USERS);
        await run(db);
        const before = await snapshot(db);

        await setKey(db, null);
        await expect(undo(db)).to.be.rejectedWith(InvalidOption);
        expect(await snapshot(db)).to.eq(before);

        await setKey(db, randomBytes(32).toString('hex'));
        await expect(undo(db)).to.be.rejectedWith(/key/);
        expect(await snapshot(db)).to.eq(before);
      });

      it('down() without carried TOTP rows needs no key', async () => {
        await seedLegacy(db, [DAVE]);
        await run(db);
        await setKey(db, null);

        await undo(db);

        expect(await metadataKeys(db, DAVE.Uuid)).to.deep.eq(['user:phone']);
      });

      it('up after down after up gives the same MFA rows and metadata', async () => {
        await seedLegacy(db, USERS);
        await run(db);
        const key = mfaKeyFrom(KEY);
        const view = async () => ({
          mfa: (await mfaRows(db)).map((r) => [r.identity, r.step, r.key_id, r.confirmed_text !== null, decryptMfaSecret(key, r.identity, r.step, r.secret_enc)]),
          meta: await Promise.all(USERS.map((u) => metadataOf(db, u.Uuid))),
        });
        const first = await view();

        await undo(db);
        await run(db);

        expect(await view()).to.deep.eq(first);
      });

      it('reads 2fa:enabled by its Type as 2.x did: every form 2.x saw as true confirms', async () => {
        const users = ENABLED_FORMS.map(([type, value], i) => legacyUser(100 + i, [meta('2fa:token', `SECRET${i}`), ...(type ? [meta('2fa:enabled', value, type)] : [])]));
        await seedLegacy(db, users);
        await run(db);

        const rows = await mfaRows(db);
        ENABLED_FORMS.forEach(([type, value, confirmed], i) => {
          const r = rows.find((x) => x.identity === `user:${users[i].Uuid}`);
          expect(r, `${type} ${value}`).to.not.be.undefined;
          expect(r!.confirmed_text !== null, `${type} ${String(value)}`).to.eq(confirmed);
        });
      });

      it('reads user:invite:pending by its Type as 2.x did: only a value 2.x saw as exactly true makes an invite', async () => {
        const users = INVITE_FORMS.map(([type, value], i) => legacyUser(200 + i, [meta('user:pwd_reset:token', `token-${i}`), meta('user:pwd_reset:start_date', at(-60), 'datetime'), meta('user:pwd_reset:wait_time', '3600', 'number'), meta('user:invite:pending', value, type)]));
        await seedLegacy(db, users);
        await run(db);

        const rows = await secretRows(db);
        INVITE_FORMS.forEach(([type, value, invite], i) => {
          const r = rows.find((x) => x.identity === `user:${users[i].Uuid}`);
          expect(r?.purpose, `${type} ${String(value)}`).to.eq(invite ? 'invite' : 'reset');
        });
      });

      for (const key of ['2fa:token', 'user:pwd_reset:token']) {
        it(`throws when the carry loses a ${key} the census counted, and rolls everything back`, async () => {
          await seedLegacy(db, USERS);
          const before = await snapshot(db);

          await expect(run(db, new LosesOneValue(key))).to.be.rejectedWith(UnexpectedServerError, /count check failed/);

          expect(await snapshot(db)).to.eq(before);
        });
      }

      it('throws when a security key is still in users_metadata after the delete, and rolls everything back', async () => {
        await seedLegacy(db, USERS);
        const before = await snapshot(db);

        await expect(run(db, new MissesOneRow())).to.be.rejectedWith(UnexpectedServerError, /still in users_metadata/);

        expect(await snapshot(db)).to.eq(before);
      });

      it('refuses a reset token shared by two users, naming the users and not the token', async () => {
        const twin = legacyUser(300, [meta('user:pwd_reset:token', RESET_A), meta('user:pwd_reset:start_date', at(-10), 'datetime'), meta('user:pwd_reset:wait_time', '3600', 'number')]);
        await seedLegacy(db, [ALICE, twin]);
        const before = await snapshot(db);

        const err = await run(db).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(err).to.be.instanceOf(InvalidOperation);
        const message = (err as Error).message;
        expect(message).to.contain(ALICE.Uuid).and.contain(twin.Uuid);
        expect(message).to.not.contain(RESET_A).and.not.contain(sha256hex(RESET_A));
        expect(await snapshot(db)).to.eq(before);
      });

      it('down() keeps the clear secret out of the error when a restore insert fails', async () => {
        await seedLegacy(db, USERS);
        await run(db);
        const before = await snapshot(db);

        const err = await undo(db, new FailingRestore()).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(err).to.be.instanceOf(UnexpectedServerError);
        const seen = `${inspect(err, { depth: 10, showHidden: true })} ${JSON.stringify(err)} ${String((err as Error).stack)}`;
        for (const secret of [SECRET_A, SECRET_B, SECRET_C]) {
          expect(seen).to.not.contain(secret);
        }
        expect(await snapshot(db)).to.eq(before);
      });

      it('logs one summary line with counts and no values; a warning when secrets were deleted without a carry', async () => {
        const expired = legacyUser(400, [meta('user:pwd_reset:token', 'expired-token'), meta('user:pwd_reset:start_date', at(-7200), 'datetime'), meta('user:pwd_reset:wait_time', '3600', 'number')]);
        const noStart = legacyUser(401, [meta('user:pwd_reset:token', 'nostart-token'), meta('user:pwd_reset:wait_time', '3600', 'number')]);
        await seedLegacy(db, [...USERS, expired, noStart]);
        const m = new CapturingMigration();

        await run(db, m);

        expect(m.infos).to.deep.eq([]);
        expect(m.warnings).to.have.length(1);
        const line = m.warnings[0];
        for (const part of ['carried 3 TOTP secret(s) (2 confirmed, 1 unconfirmed)', '1 reset(s) and 1 invite(s)', 'dropped 1 expired and 1 malformed', 'deleted 22 users_metadata row(s)', '1 non-empty user:2fa:*', '0 owner(s) missing']) {
          expect(line).to.contain(part);
        }
        for (const value of [SECRET_A, SECRET_B, SECRET_C, RESET_A, INVITE_C, 'LEGACYSECRETAAAA', 'expired-token', 'nostart-token', ALICE.Email, ALICE.Uuid]) {
          expect(line).to.not.contain(value);
        }

        await clean(db);
        await seedLegacy(db, [CAROL, DAVE]);
        const quiet = new CapturingMigration();
        await run(db, quiet);
        expect(quiet.warnings).to.deep.eq([]);
        expect(quiet.infos).to.have.length(1);
        expect(quiet.infos[0]).to.contain('carried 1 TOTP secret(s)');
      });

      it('runs as a savepoint inside an outer transaction: a failed run leaves the outer one usable', async () => {
        await seedLegacy(db, USERS);
        const before = await snapshot(db);

        await expect(
          db.driver.transaction(async () => {
            await expect(run(db, new SkipOneInsert('authn_mfa'))).to.be.rejectedWith(/count check failed/);
            expect((await db.driver.select().from('authn_mfa')) as unknown[]).to.have.length(0);
            await run(db);
            expect((await db.driver.select().from('authn_mfa')) as unknown[]).to.have.length(3);
            throw new Error('outer rollback');
          }),
        ).to.be.rejectedWith('outer rollback');

        expect(await snapshot(db)).to.eq(before);
      });

      it('deletes the security keys of a users_metadata owner missing from users and carries nothing for it', async () => {
        await seedLegacy(db, [DAVE]);
        await insertOrphan(db, [meta('2fa:token', SECRET_A), meta('user:pwd_reset:token', RESET_A), meta('user:pwd_reset:start_date', at(-60), 'datetime'), meta('user:pwd_reset:wait_time', '3600', 'number'), meta('user:phone', 'kept')]);
        await setKey(db, null);
        const m = new CapturingMigration();

        await run(db, m);

        const left = (await db.driver.select().from('users_metadata').where('user_id', ORPHAN_ID)) as Record<string, unknown>[];
        expect(left.map((r) => r.Key)).to.deep.eq(['user:phone']);
        expect(await mfaRows(db)).to.deep.eq([]);
        expect(await secretRows(db)).to.deep.eq([]);
        expect(m.warnings.join('\n')).to.contain('the keys of 1 owner(s) missing from users');
      });

      it('a second up() after a successful one changes nothing and needs no key', async () => {
        await seedLegacy(db, USERS);
        await run(db);
        await setKey(db, null);
        const before = await snapshot(db);

        await run(db);

        expect(await snapshot(db)).to.eq(before);
      });

      it('reads a start date without an offset as UTC', async () => {
        await seedLegacy(db, [legacyUser(500, [meta('user:pwd_reset:token', RESET_A), meta('user:pwd_reset:start_date', '2026-06-01T09:59:00.000', 'datetime'), meta('user:pwd_reset:wait_time', '3600', 'number')])]);

        await run(db);

        const [row] = await secretRows(db);
        expect(ms(row.created_at)).to.eq(T0.getTime() - 60_000);
        expect(ms(row.expires_at)).to.eq(T0.getTime() + 3_540_000);
      });
    });
  });

  describe(`${MIGRATION} without 2.x tables (${kind})`, function () {
    this.timeout(120000);

    let db: TestDb;

    before(async function () {
      db = await bootDb(this, kind, 'upgrade_fresh');
    });

    after(async () => {
      await db?.dispose();
    });

    it('is a no-op on startup, in up() and in down() when users_metadata does not exist', async () => {
      const status = (await db.orm.Migration.status()).find((s) => s.name === MIGRATION);
      expect(status?.failed).to.eq(false);
      expect(status?.pending).to.eq(false);
      expect(await db.driver.schema().tableExists('users_metadata')).to.eq(false);

      await run(db);
      await undo(db);

      for (const table of ['authn_mfa', 'authn_secret']) {
        expect(await rawQuery(db.driver, `SELECT * FROM ${table}`), table).to.deep.eq([]);
      }
    });
  });
}
