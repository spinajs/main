import 'mocha';
import { expect } from 'chai';
import { randomBytes, randomUUID } from 'node:crypto';
import type { OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { Upload_2026_10_23_00_00_00 } from '../../src/index.js';
import { bootConfiguration } from '../support/config.js';
import { POSTGRES, connectPostgres, postgresAdmin, requireServer } from '../support/servers.js';

const PENDING = Symbol('pending');

function within<T>(work: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return Promise.race([work, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))]);
}

describe('spike: UploadStore.insertSessionWithinCap serialises the creates of one owner on Postgres', function () {
  this.timeout(60000);
  const database = `upload_owner_lock_${randomBytes(4).toString('hex')}`;
  let driver: OrmDriver | undefined;

  before(async function () {
    await bootConfiguration();
    await requireServer(this, 'postgres', POSTGRES.Host, POSTGRES.Port);
    await postgresAdmin(`CREATE DATABASE ${database}`);
    driver = await connectPostgres(database, 4);
    await new Upload_2026_10_23_00_00_00().up(driver);
  });

  after(async () => {
    if (!driver) return;
    await driver.disconnect();
    await postgresAdmin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });

  const insert = async (owner: string) => {
    const now = DateTime.utc();
    await driver!.insert().into('upload_sessions').values({ id: randomUUID(), owner, name: 'n.txt', size: 1, part_size: 1, part_count: 1, status: 'open', metadata: '{}', temp_fs: 't', files_fs: 'f', created_at: now, updated_at: now, expires_at: now });
  };
  // The statements of UploadStore.lockOwner and openSessionsOf.
  const lockOwner = async (owner: string) => {
    await driver!.update().in('upload_sessions').update({ owner }).where({ owner, status: 'open' });
  };
  const openOf = async (owner: string) => ((await driver!.select().from('upload_sessions').where({ owner, status: 'open' })) as unknown[]).length;

  /** Locks, counts and inserts in a transaction that stays open until `release()`. */
  function holding(owner: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let ran!: (n: number) => void;
    const counted = new Promise<number>((resolve) => (ran = resolve));
    const tx = driver!.transaction(async () => {
      await lockOwner(owner);
      ran(await openOf(owner));
      await insert(owner);
      await gate;
    });
    return { tx, counted, release };
  }

  it('with an open session, a second create waits for the first and then counts its row', async () => {
    const owner = `o-${randomUUID()}`;
    await insert(owner);

    const first = holding(owner);
    expect(await first.counted).to.eq(1);

    const second = driver!.transaction(async () => {
      await lockOwner(owner);
      return openOf(owner);
    });
    expect(await within(second, 750)).to.eq(PENDING);

    first.release();
    await first.tx;
    expect(await second).to.eq(2);
  });

  it('with no open session there is nothing to lock: a second create runs at once and misses the uncommitted row', async () => {
    const owner = `o-${randomUUID()}`;

    const first = holding(owner);
    expect(await first.counted).to.eq(0);

    const second = driver!.transaction(async () => {
      await lockOwner(owner);
      return openOf(owner);
    });
    expect(await within(second, 750)).to.eq(0);

    first.release();
    await first.tx;
  });
});
