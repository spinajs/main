/* eslint-disable @typescript-eslint/no-explicit-any */
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { QueryContext } from '@spinajs/orm';

import './migrations/PgTypesMigration_2026_10_15_00_02_00.js';
import { IPgSuite, openSuite } from './harness.js';
import { PgSoft } from './models/types.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

describe('postgres integration - soft delete and raw SQL', function () {
  let suite: IPgSuite;

  before(async function () {
    suite = await openSuite(this, { name: 'misc' });
  });

  beforeEach(async () => {
    await suite.reset('pg_soft');
  });

  after(async () => {
    await suite?.close();
  });

  it('hides soft-deleted rows by default and shows them with withDeleted()', async () => {
    await PgSoft.insert([{ Val: 'a' }, { Val: 'b' }, { Val: 'c' }] as any);
    await PgSoft.destroy(2);

    expect((await PgSoft.all()).map((r) => r.Id)).to.deep.equal([1, 3]);
    expect((await PgSoft.all().withDeleted()).map((r) => r.Id).sort()).to.deep.equal([1, 2, 3]);
    const [row] = await suite.raw<{ DeletedAt: Date | null }[]>('SELECT "DeletedAt" FROM "pg_soft" WHERE "Id" = 2');
    expect(row.DeletedAt).to.be.instanceOf(Date);
  });

  it('binds ? placeholders in raw SQL as $n, in order', async () => {
    const rows = await suite.raw<{ a: number; b: string }[]>('SELECT ?::int AS a, ?::text AS b', [7, 'x']);
    expect(rows).to.deep.equal([{ a: 7, b: 'x' }]);
  });

  it('leaves a ? inside a literal alone when the statement has no bindings', async () => {
    expect(await suite.raw(`SELECT '?' AS q`)).to.deep.equal([{ q: '?' }]);
  });

  it('runs the jsonb key-exists operator when the statement has no bindings', async () => {
    expect(await suite.raw(`SELECT '{"a":1}'::jsonb ? 'a' AS has`)).to.deep.equal([{ has: true }]);
  });

  it('tests a jsonb key with a binding through jsonb_exists()', async () => {
    expect(await suite.raw(`SELECT jsonb_exists('{"a":1}'::jsonb, ?) AS has`, ['a'])).to.deep.equal([{ has: true }]);
  });

  it('answers SHOW through schema().raw() (authz-orm reads jit this way)', async () => {
    const rows = (await suite.driver.schema().raw('SHOW jit')) as { jit: string }[];
    expect(['on', 'off']).to.include(rows[0].jit);
  });

  it('reports affected rows of a raw UPDATE', async () => {
    await PgSoft.insert([{ Val: 'a' }, { Val: 'a' }] as any);
    const result = await suite.driver.executeOnDb('UPDATE "pg_soft" SET "Val" = ? WHERE "Val" = ?', ['b', 'a'], QueryContext.Update);
    expect(result.RowsAffected).to.equal(2);
  });
});
