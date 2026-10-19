import * as chai from 'chai';
import 'mocha';

import { DbAuthzAdminBackend, readVersion } from '../../../src/index.js';
import { bootDb } from '../../support/db.js';
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
    const gate = new Promise<void>((r) => (release = r));

    const slow = backend.transaction('pg_d1', async (tx) => {
      await gate;
      await backend.bumpVersion('pg_d1', tx);
    });
    const fast = backend.transaction('pg_d2', async (tx) => {
      await backend.bumpVersion('pg_d2', tx);
      return 'done';
    });

    const winner = await Promise.race([fast, new Promise((r) => setTimeout(() => r('queued behind pg_d1'), 5000))]);
    release();
    await Promise.all([slow, fast]);

    expect(winner).to.eq('done');
    expect(await readVersion('pg_d1')).to.eq('1');
    expect(await readVersion('pg_d2')).to.eq('1');
  });
});
