import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';

import './migrations/PgCoreMigration_2026_10_15_00_00_00.js';
import { IPgSuite, PG, openSuite } from './harness.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('postgres integration - connection', function () {
  let suite: IPgSuite;

  before(async function () {
    suite = await openSuite(this, { name: 'conn' });
  });

  after(async () => {
    await suite?.close();
  });

  it('talks to PostgreSQL 16', async () => {
    const [row] = await suite.raw<{ v: number }[]>(`SELECT current_setting('server_version_num')::int AS v`);
    expect(row.v).to.be.at.least(160000);
  });

  it('runs every pooled statement inside the suite schema', async () => {
    const rows = await Promise.all([1, 2, 3, 4].map(() => suite.raw<{ s: string }[]>('SELECT current_schema() AS s, pg_sleep(0.05)')));
    expect(rows.map((r) => r[0].s)).to.deep.equal([suite.schema, suite.schema, suite.schema, suite.schema]);
  });

  it('has no schema named after the database, so a database-qualified name cannot resolve by accident', async () => {
    expect(await suite.raw('SELECT nspname FROM pg_namespace WHERE nspname = ?', [PG.Database])).to.deep.equal([]);
  });

  it('migrated into the suite schema, ledger included', async () => {
    const rows = await suite.raw<{ table_name: string }[]>('SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [suite.schema]);
    expect(rows.map((r) => r.table_name)).to.include.members(['orm_migrations', 'pg_auto_key', 'pg_person']);
  });

  it('reads a table descriptor from the suite schema', async () => {
    const info = await suite.driver.tableInfo('pg_auto_key');
    expect(info.map((c) => c.Name)).to.deep.equal(['Id', 'Name']);
    expect(info[0].PrimaryKey).to.equal(true);
    expect(info[0].AutoIncrement).to.equal(true);
  });

  it('answers a ping', async () => {
    expect(await suite.driver.ping()).to.equal(true);
  });

  it('reports pool metrics within the configured maximum', async () => {
    await suite.raw('SELECT 1');
    const m = suite.driver.poolMetrics();
    expect(m.Size).to.be.within(1, 4);
    expect(m.Waiting).to.equal(0);
  });
});
