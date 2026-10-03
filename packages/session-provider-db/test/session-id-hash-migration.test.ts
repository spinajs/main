import { expect } from 'chai';
import { DateTime } from 'luxon';
import type { OrmDriver } from '@spinajs/orm';
import { UserSession } from '@spinajs/authn-session';
import { DI } from '@spinajs/di';
import { DbSessionStore, UserSessionDBSqlMigration_2022_06_28_01_20_00, UserSessionIdHash_2026_10_02_00_00_00 } from '../src/index.js';
import { bootStore, disposeStore, seedLegacyRow, sessionConnection } from './support.js';

const user = (id: string) => ({ type: 'user', id });

async function columns(connection: OrmDriver): Promise<Map<string, { Nullable: boolean }>> {
  return new Map((await connection.tableInfo('user_sessions')).map((c) => [c.Name, c]));
}

async function indexes(connection: OrmDriver): Promise<string[]> {
  const rows = (await connection.select().from('sqlite_master').where('type', 'index').where('tbl_name', 'user_sessions')) as Array<{ name: string; sql: string | null }>;
  return rows.map((r) => `${r.name} ${r.sql ?? ''}`);
}

async function rowOf(connection: OrmDriver, id: string): Promise<Record<string, unknown>> {
  return ((await connection.select().from('user_sessions').where('SessionId', id)) as Record<string, unknown>[])[0];
}

const ACTIVE = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const PENDING = '1a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const NO_USER = '2a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

describe('UserSessionIdHash_2026_10_02_00_00_00', function () {
  this.timeout(15000);

  let connection: OrmDriver;

  /** Rebuilds user_sessions in its 2.x shape, with 2.x rows in it, and runs the migration over it. */
  async function upgradeA2xTable(): Promise<void> {
    await bootStore();
    connection = await sessionConnection();
    await connection.schema().raw('DROP TABLE user_sessions');
    await new UserSessionDBSqlMigration_2022_06_28_01_20_00().up(connection);
    expect((await columns(connection)).has('Subject'), 'the table starts in its 2.x shape').to.be.false;

    const creation = DateTime.now().minus({ minutes: 1 });
    const expiration = creation.plus({ minutes: 30 });
    await seedLegacyRow({ rawId: ACTIVE, user: 'u-a', impersonator: 'u-admin', authorized: true, creation, expiration });
    await seedLegacyRow({ rawId: PENDING, user: 'u-b', authorized: false, creation, expiration });
    await seedLegacyRow({ rawId: NO_USER, authorized: true, creation, expiration });

    await new UserSessionIdHash_2026_10_02_00_00_00().up(connection);
  }

  after(async () => {
    await disposeStore();
  });

  it('adds Subject, ImpersonatorId and State as nullable columns and makes UserId nullable', async () => {
    await upgradeA2xTable();
    const cols = await columns(connection);

    for (const c of ['Subject', 'ImpersonatorId', 'State', 'UserId']) {
      expect(cols.get(c), c).to.not.be.undefined;
      expect(cols.get(c)!.Nullable, `${c} nullable`).to.be.true;
    }
  });

  it('SR-06 indexes Subject and ImpersonatorId, and keeps the unique SessionId index (the sqlite widen skips, the columns and indexes do not)', async () => {
    await upgradeA2xTable();
    const idx = await indexes(connection);

    expect(
      idx.some((i) => i.includes('(`ImpersonatorId`)') || i.includes('("ImpersonatorId")') || i.includes('(ImpersonatorId)')),
      idx.join('\n'),
    ).to.be.true;
    expect(
      idx.some((i) => i.includes('(`Subject`)') || i.includes('("Subject")') || i.includes('(Subject)')),
      idx.join('\n'),
    ).to.be.true;
    expect(
      idx.some((i) => i.startsWith('session_id_user_session_idx ')),
      idx.join('\n'),
    ).to.be.true;
  });

  it('backfills Subject, ImpersonatorId and State of 2.x rows from their Data and keeps the raw keys', async () => {
    await upgradeA2xTable();

    const active = await rowOf(connection, ACTIVE);
    expect(active.Subject).to.equal('user:u-a');
    expect(active.ImpersonatorId).to.equal('user:u-admin');
    expect(active.State).to.equal('active');

    const pending = await rowOf(connection, PENDING);
    expect(pending.Subject).to.equal('user:u-b');
    expect(pending.ImpersonatorId ?? null).to.equal(null);
    expect(pending.State, 'SR-07 a 2.x row that never passed 2FA is backfilled pending').to.equal('pending');

    const orphan = await rowOf(connection, NO_USER);
    expect(orphan.Subject ?? null).to.equal(null);
    expect(orphan.State ?? null).to.equal(null);
  });

  it('A08 SR-06 the 3.0 queries reach the backfilled rows', async () => {
    await upgradeA2xTable();
    const provider = await DI.resolve(DbSessionStore);

    expect((await provider.listBySubject(user('u-admin'), { includeImpersonations: true })).map((s) => s.SessionId)).to.deep.equal([ACTIVE]);
    expect(await provider.deleteBySubject(user('u-admin'), { includeImpersonations: true })).to.equal(1);
    expect(await provider.restore(ACTIVE)).to.be.null;
  });

  it('a 3.0 row without UserId fits after the upgrade, under a 64 char key', async () => {
    await upgradeA2xTable();
    const provider = await DI.resolve(DbSessionStore);

    const key = 'f'.repeat(64);
    await provider.save(new UserSession({ SessionId: key, Subject: user('u-c'), State: 'active', Data: new Map() }));
    expect((await provider.restore(key))!.SessionId).to.equal(key);
  });

  it('a 2.x row whose Data does not decode neither fails the migration nor blocks the backfill of the others', async () => {
    await bootStore();
    connection = await sessionConnection();
    await connection.schema().raw('DROP TABLE user_sessions');
    await new UserSessionDBSqlMigration_2022_06_28_01_20_00().up(connection);
    const creation = DateTime.now().minus({ minutes: 1 });
    const expiration = creation.plus({ minutes: 30 });
    await connection.insert().into('user_sessions').values({ SessionId: NO_USER, CreatedAt: creation, Expiration: expiration, Data: '{not json', UserId: 1 });
    await seedLegacyRow({ rawId: ACTIVE, user: 'u-a', authorized: true, creation, expiration });

    await new UserSessionIdHash_2026_10_02_00_00_00().up(connection);

    expect((await rowOf(connection, ACTIVE)).Subject).to.equal('user:u-a');
    expect((await rowOf(connection, NO_USER)).Subject ?? null).to.equal(null);
  });

  it('runs twice without failing', async () => {
    await upgradeA2xTable();
    await new UserSessionIdHash_2026_10_02_00_00_00().up(connection);
    expect((await rowOf(connection, ACTIVE)).Subject).to.equal('user:u-a');
  });

  it('down drops the new columns and their indexes', async () => {
    await upgradeA2xTable();
    await new UserSessionIdHash_2026_10_02_00_00_00().down(connection);

    const cols = await columns(connection);
    for (const c of ['Subject', 'ImpersonatorId', 'State']) {
      expect(cols.has(c), c).to.be.false;
    }
    expect((await rowOf(connection, ACTIVE)).SessionId, 'rows survive').to.equal(ACTIVE);
  });
});
