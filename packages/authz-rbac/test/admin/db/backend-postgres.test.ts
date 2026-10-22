import * as chai from 'chai';
import 'mocha';

import { DbAuthzAdminBackend, readVersion } from '../../../src/index.js';
import { bootDb, PG_ACQUIRE_TIMEOUT } from '../../support/db.js';
import type { TestDb } from '../../support/db.js';

const expect = chai.expect;

describe('DbAuthzAdminBackend on Postgres', function () {
  this.timeout(60_000);

  let db: TestDb | undefined;

  before(async function () {
    db = await bootDb(this, 'postgres', 'backend_pg');
  });

  after(async () => {
    await db?.dispose();
  });

  it('runs batches of different domains side by side', async () => {
    const backend = new DbAuthzAdminBackend();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const slow = backend.transaction('pg_d1', async (tx) => {
      await gate;
      await backend.bumpVersion('pg_d1', tx);
    });
    const fast = backend.transaction('pg_d2', async (tx) => {
      await backend.bumpVersion('pg_d2', tx);
      return 'done';
    });

    const winner = await Promise.race([fast, new Promise((resolve) => setTimeout(() => resolve('queued behind pg_d1'), PG_ACQUIRE_TIMEOUT))]);
    release();
    await Promise.all([slow, fast]);

    expect(winner).to.eq('done');
    expect(await readVersion('pg_d1')).to.eq('1');
    expect(await readVersion('pg_d2')).to.eq('1');
  });

  it('orders two concurrent batches of one domain on the version row, without a deadlock', async () => {
    const backend = new DbAuthzAdminBackend();
    const before = BigInt(await readVersion('pg_same'));
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const first = backend.transaction('pg_same', async (tx) => {
      events.push('first:start');
      await gate;
      await backend.bumpVersion('pg_same', tx);
      events.push('first:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = backend.transaction('pg_same', async (tx) => {
      events.push('second:start');
      await backend.bumpVersion('pg_same', tx);
      events.push('second:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(events).to.deep.eq(['first:start']);
    release();
    await Promise.all([first, second]);

    expect(events).to.deep.eq(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(await readVersion('pg_same')).to.eq(String(before + 2n));
  });
});
