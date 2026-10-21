import 'mocha';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { QueryContext } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { UserSession } from '@spinajs/authn-session';
import type { DbSessionStore } from '../src/index.js';
import { bootStore, disposeStore, sessionConnection, storedKeys } from './support.js';

type Executor = { executeOnDb(sql: string, bindings: unknown[], context: QueryContext): Promise<unknown> };

async function indexColumns(connection: OrmDriver, table: string): Promise<Map<string, string[]>> {
  const run = (sql: string) => (connection as unknown as Executor).executeOnDb(sql, [], QueryContext.Select) as Promise<Array<Record<string, unknown>>>;
  const result = new Map<string, string[]>();
  for (const idx of await run(`PRAGMA index_list(${table})`)) {
    const name = String(idx.name);
    result.set(name, (await run(`PRAGMA index_info(${name})`)).map((c) => String(c.name)));
  }
  return result;
}

/** Counts the DELETE statements `connection` runs until `restore()`. */
function countDeletes(connection: OrmDriver): { count(): number; restore(): void } {
  const target = connection as unknown as Executor;
  const original = target.executeOnDb.bind(target);
  let deletes = 0;
  target.executeOnDb = (sql, bindings, context) => {
    if (context === QueryContext.Delete && /^\s*delete\b/i.test(sql)) {
      deletes++;
    }
    return original(sql, bindings, context);
  };
  return { count: () => deletes, restore: () => void delete (target as Partial<Executor>).executeOnDb };
}

async function seed(store: DbSessionStore, expired: number, live: number): Promise<void> {
  const subject = { type: 'user', id: 'cleanup' };
  const save = (id: string, expiration: DateTime) => store.save(new UserSession({ SessionId: id.padStart(64, '0'), Subject: subject, State: 'active', Expiration: expiration, Data: new Map() }));
  for (let i = 0; i < expired; i++) {
    await save(`e${i}`, DateTime.now().minus({ hours: 1, minutes: i % 60 }));
  }
  for (let i = 0; i < live; i++) {
    await save(`l${i}`, DateTime.now().plus({ hours: 1 }));
  }
}

describe('db session provider cleanup', function () {
  this.timeout(60000);

  let deletes: ReturnType<typeof countDeletes> | undefined;

  afterEach(() => {
    deletes?.restore();
    deletes = undefined;
  });

  after(async () => {
    await disposeStore();
  });

  it('indexes Expiration', async () => {
    await bootStore();

    const idx = await indexColumns(await sessionConnection(), 'user_sessions');

    expect([...idx.values()].some((cols) => cols.length === 1 && cols[0] === 'Expiration'), JSON.stringify([...idx])).to.be.true;
  });

  it('reads authn.session.db.cleanupBatch, 500 by default', async () => {
    const store = await bootStore();

    expect((store as unknown as { CleanupBatch: number }).CleanupBatch).to.equal(500);
  });

  it('removes 1250 expired sessions in 3 DELETE statements and reports 1250', async () => {
    const store = await bootStore();
    await seed(store, 1250, 4);
    deletes = countDeletes(await sessionConnection());

    expect(await store.cleanupExpired()).to.equal(1250);

    expect(deletes.count()).to.equal(3);
    expect(await storedKeys()).to.have.length(4);
  });

  it('honours a configured cleanupBatch', async () => {
    const store = await bootStore({ db: { cleanupBatch: 100 } });
    await seed(store, 250, 0);
    deletes = countDeletes(await sessionConnection());

    expect(await store.cleanupExpired()).to.equal(250);

    expect(deletes.count()).to.equal(3);
  });

  it('answers 0 and issues no DELETE when nothing has expired', async () => {
    const store = await bootStore();
    await seed(store, 0, 3);
    deletes = countDeletes(await sessionConnection());

    expect(await store.cleanupExpired()).to.equal(0);

    expect(deletes.count()).to.equal(0);
    expect(await storedKeys()).to.have.length(3);
  });
});
