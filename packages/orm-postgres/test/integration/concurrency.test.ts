import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { QueryContext } from '@spinajs/orm';

import './migrations/PgTypesMigration_2026_10_15_00_02_00.js';
import { IPgSuite, openSuite, sqlState } from './harness.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

type Affected = { RowsAffected: number };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('postgres integration - concurrency', function () {
  let suite: IPgSuite;

  const claim = (owner: string) =>
    suite.driver.executeOnDb(
      `UPDATE "pg_lease" SET "Owner" = ?, "LeaseUntil" = now() + interval '300 milliseconds' WHERE "Name" = ? AND ("Owner" IS NULL OR "LeaseUntil" < now())`,
      [owner, 'job'],
      QueryContext.Update,
    ) as Promise<Affected>;

  before(async function () {
    // enough connections for every racer to run on its own session
    suite = await openSuite(this, { name: 'conc', pool: { Max: 10 } });
  });

  beforeEach(async () => {
    await suite.reset('pg_lease');
    await suite.raw('INSERT INTO "pg_lease" ("Name") VALUES (?)', ['job']);
  });

  after(async () => {
    await suite?.close();
  });

  it('lets exactly one of eight concurrent conditional updates win', async () => {
    const attempts = (await Promise.all(Array.from({ length: 8 }, (_, i) => suite.driver.update().in('pg_lease').update({ Owner: `w${i}` }).where('Name', 'job').whereNull('Owner')))) as unknown as Affected[];

    expect(attempts.map((a) => a.RowsAffected).sort()).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
    const [row] = await suite.raw<{ Owner: string }[]>('SELECT "Owner" FROM "pg_lease" WHERE "Name" = ?', ['job']);
    expect(row.Owner).to.equal(`w${attempts.findIndex((a) => a.RowsAffected === 1)}`);
  });

  it('holds a lease on database time and frees it when it expires', async () => {
    expect((await claim('a')).RowsAffected).to.equal(1);
    expect((await claim('b')).RowsAffected).to.equal(0);

    await sleep(400);

    expect((await claim('b')).RowsAffected).to.equal(1);
  });

  it('applies compare-and-set on a version column once', async () => {
    const bump = () => suite.driver.executeOnDb('UPDATE "pg_lease" SET "Version" = "Version" + 1 WHERE "Name" = ? AND "Version" = ?', ['job', 0], QueryContext.Update) as Promise<Affected>;

    const results = await Promise.all([bump(), bump(), bump()]);

    expect(results.map((r) => r.RowsAffected).sort()).to.deep.equal([0, 0, 1]);
  });

  it('rejects all but one concurrent insert of the same key', async () => {
    const inserts = await Promise.allSettled(Array.from({ length: 4 }, () => suite.raw('INSERT INTO "pg_lease" ("Name") VALUES (?)', ['other'])));

    expect(inserts.filter((r) => r.status === 'fulfilled')).to.have.length(1);
    expect(inserts.filter((r) => r.status === 'rejected').map((r) => sqlState((r as PromiseRejectedResult).reason))).to.deep.equal(['23505', '23505', '23505']);
  });
});
