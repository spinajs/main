import 'mocha';
import { expect } from 'chai';
import { randomBytes, randomUUID } from 'node:crypto';
import { rowsAffected } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { bootConfiguration } from '../support/config.js';
import { POSTGRES, connectPostgres, postgresAdmin, requireServer } from '../support/servers.js';

const PENDING = Symbol('pending');

function within<T>(work: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return Promise.race([work, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))]);
}

describe('spike §11.4: the first conditional UPDATE of a transaction serialises a claim on Postgres', function () {
  this.timeout(60000);
  const database = `upload_lock_${randomBytes(4).toString('hex')}`;
  let driver: OrmDriver | undefined;

  before(async function () {
    await bootConfiguration();
    await requireServer(this, 'postgres', POSTGRES.Host, POSTGRES.Port);
    await postgresAdmin(`CREATE DATABASE ${database}`);
    driver = await connectPostgres(database, 4);
    await driver.schema().createTable('spike_sessions', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('status', 16).notNull();
      table.dateTime('updated_at').notNull();
    });
  });

  after(async () => {
    if (!driver) return;
    await driver.disconnect();
    await postgresAdmin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });

  const openSession = async (id: string) => {
    await driver!.insert().into('spike_sessions').values({ id, status: 'open', updated_at: DateTime.utc() });
  };
  // What putPart's commit does first (spec §4.1 step 4).
  const touchOpen = async (id: string) => rowsAffected(await driver!.update().in('spike_sessions').update({ updated_at: DateTime.utc() }).where({ id, status: 'open' }));
  // What the complete claim does (spec §5).
  const claim = async (id: string) => rowsAffected(await driver!.update().in('spike_sessions').update({ status: 'assembling' }).where({ id, status: 'open' }));

  /** Runs `work` in a transaction that stays open until `release()`. `done` resolves with work's result once it ran. */
  function holding(work: () => Promise<number>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let ran!: (n: number) => void;
    const done = new Promise<number>((resolve) => (ran = resolve));
    const tx = driver!.transaction(async () => {
      ran(await work());
      await gate;
    });
    return { tx, done, release };
  }

  it('a part commit holding the row lock makes the claim wait; the claim then matches', async () => {
    const id = randomUUID();
    await openSession(id);

    const part = holding(() => touchOpen(id));
    expect(await part.done).to.eq(1);

    const claiming = driver!.transaction(() => claim(id));
    expect(await within(claiming, 750)).to.eq(PENDING);

    part.release();
    await part.tx;
    expect(await claiming).to.eq(1);
  });

  it('a claim holding the row lock makes the part commit wait; the commit then matches no row', async () => {
    const id = randomUUID();
    await openSession(id);

    const claimed = holding(() => claim(id));
    expect(await claimed.done).to.eq(1);

    const committing = driver!.transaction(() => touchOpen(id));
    expect(await within(committing, 750)).to.eq(PENDING);

    claimed.release();
    await claimed.tx;
    // READ COMMITTED re-checks the WHERE on the row the claim committed, so status = 'open' no longer holds.
    expect(await committing).to.eq(0);
  });
});
