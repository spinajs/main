import { expect } from 'chai';
import type { OrmDriver } from '@spinajs/orm';
import { UserSession } from '@spinajs/authn-session';
import { bootStore, disposeStore, sessionConnection } from './support.js';

async function columns(connection: OrmDriver): Promise<Map<string, { Nullable: boolean }>> {
  return new Map((await connection.tableInfo('user_sessions')).map((c) => [c.Name, c]));
}

async function indexes(connection: OrmDriver): Promise<string[]> {
  const rows = (await connection.select().from('sqlite_master').where('type', 'index').where('tbl_name', 'user_sessions')) as Array<{ name: string; sql: string | null }>;
  return rows.map((r) => `${r.name} ${r.sql ?? ''}`);
}

const indexesColumn = (idx: string[], column: string) => idx.some((i) => i.includes(`(\`${column}\`)`) || i.includes(`("${column}")`) || i.includes(`(${column})`));

describe('UserSessionDBSqlMigration_2022_06_28_01_20_00', function () {
  this.timeout(15000);

  after(async () => {
    await disposeStore();
  });

  it('creates Subject, ImpersonatorId and State as nullable columns, SessionId not null, and no UserId', async () => {
    await bootStore();
    const cols = await columns(await sessionConnection());

    expect(cols.has('UserId'), 'UserId').to.be.false;
    for (const c of ['Subject', 'ImpersonatorId', 'State']) {
      expect(cols.get(c), c).to.not.be.undefined;
      expect(cols.get(c)!.Nullable, `${c} nullable`).to.be.true;
    }
    expect(cols.get('SessionId')!.Nullable).to.be.false;
  });

  it('SR-06 indexes Subject and ImpersonatorId, and SessionId uniquely', async () => {
    await bootStore();
    const idx = await indexes(await sessionConnection());

    expect(indexesColumn(idx, 'Subject'), idx.join('\n')).to.be.true;
    expect(indexesColumn(idx, 'ImpersonatorId'), idx.join('\n')).to.be.true;
    expect(
      idx.some((i) => i.startsWith('session_id_user_session_idx ') && i.includes('UNIQUE')),
      idx.join('\n'),
    ).to.be.true;
  });

  it('stores a row under a 64 char key', async () => {
    const store = await bootStore();

    const key = 'f'.repeat(64);
    await store.save(new UserSession({ SessionId: key, Subject: { type: 'user', id: 'u-c' }, State: 'active', Data: new Map() }));
    expect((await store.restore(key))!.SessionId).to.equal(key);
  });
});
