/* eslint-disable prettier/prettier */
import { DI } from '@spinajs/di';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { bumpVersionRow, deleteChunked, insertChunked, OrmDriver, OrmException, purgeBatch, rowsAffected, sql, toRawQuery, whereInGroups } from '@spinajs/orm';
import * as chai from 'chai';
import 'mocha';
import { db } from './common.js';
import { bootUow, captureStatements, registerUowConnection } from './uowFixture.js';

const expect = chai.expect;

const driver = (): OrmDriver => db().Connections.get('sqlite')!;

async function items(): Promise<{ type: string; id: string; n: number }[]> {
  return (await driver().select().from('helper_item').orderBy('type').orderBy('id').asRaw<any[]>()) as { type: string; id: string; n: number }[];
}

describe('sql helpers on sqlite', function () {
  this.timeout(10000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    await driver().schema().raw('CREATE TABLE helper_item (type TEXT NOT NULL, id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (type, id))');
    await driver().schema().raw('CREATE TABLE helper_version (domain TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL)');
  });

  afterEach(() => DI.clearCache());

  it('inserts in chunks and counts the rows', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ type: i % 2 ? 'a' : 'b', id: String(i), n: i }));
    const { statements, restore } = captureStatements();
    try {
      expect(await insertChunked(driver(), 'helper_item', rows, 3)).to.equal(7);
    } finally {
      restore();
    }
    expect(statements.filter((s) => s.expression.startsWith('INSERT'))).to.have.length(3);
    expect((await items()).map((r) => r.n).sort()).to.deep.equal([0, 1, 2, 3, 4, 5, 6]);
  });

  it('rejects a duplicate key with ResourceDuplicated, other constraint failures with OrmException', async () => {
    await insertChunked(driver(), 'helper_item', [{ type: 'a', id: '1', n: 1 }]);
    const fail = async (row: object) => driver().insert().into('helper_item').values(row).then(() => undefined, (err: unknown) => err);

    expect(await fail({ type: 'a', id: '1', n: 2 })).to.be.instanceOf(ResourceDuplicated);
    const notNull = await fail({ type: 'a', id: '2', n: null });
    expect(notNull).to.be.instanceOf(OrmException).and.not.instanceOf(ResourceDuplicated);
  });

  it('counts updated rows', async () => {
    await insertChunked(driver(), 'helper_item', [{ type: 'a', id: '1', n: 1 }]);
    expect(rowsAffected(await driver().update().in('helper_item').update({ n: 5 }).where('id', '1'))).to.equal(1);
    expect(rowsAffected(await driver().update().in('helper_item').update({ n: 5 }).where('id', 'missing'))).to.equal(0);
  });

  it('matches composite keys by group', async () => {
    await insertChunked(driver(), 'helper_item', [
      { type: 'a', id: '1', n: 1 },
      { type: 'a', id: '2', n: 2 },
      { type: 'b', id: '1', n: 3 },
      { type: 'b', id: '2', n: 4 },
    ]);
    const pick = async (groups: Map<string, string[]>) => ((await whereInGroups(driver().select().from('helper_item'), 'type', 'id', groups).where('n', '>', 0).asRaw<any[]>()) as { n: number }[]).map((r) => r.n).sort();

    expect(await pick(new Map([['a', ['1']], ['b', ['2', '9']]]))).to.deep.equal([1, 4]);
    expect(await pick(new Map([['a', []]]))).to.deep.equal([]);
    expect(await pick(new Map())).to.deep.equal([]);
  });

  it('deletes in chunks, with an extra condition', async () => {
    await insertChunked(driver(), 'helper_item', Array.from({ length: 5 }, (_, i) => ({ type: 'a', id: String(i), n: i })));
    const count = await deleteChunked(driver(), 'helper_item', 'id', ['0', '1', '2', '3'], {
      size: 2,
      where: function () {
        this.where('n', '<', 3);
      },
    });
    expect(count).to.equal(3);
    expect((await items()).map((r) => r.id)).to.deep.equal(['3', '4']);
  });

  it('purges one batch of matching rows', async () => {
    await insertChunked(driver(), 'helper_item', Array.from({ length: 5 }, (_, i) => ({ type: 'a', id: String(i), n: i })));
    const stale = function (this: any) {
      this.where('n', '<', 4);
    };
    expect(await purgeBatch(driver(), { table: 'helper_item', key: 'id', where: stale, limit: 3 })).to.equal(3);
    expect(await purgeBatch(driver(), { table: 'helper_item', key: 'id', where: stale, limit: 3 })).to.equal(1);
    expect(await purgeBatch(driver(), { table: 'helper_item', key: 'id', where: stale, limit: 3 })).to.equal(0);
    expect((await items()).map((r) => r.id)).to.deep.equal(['4']);
  });

  it('bumps a version row, creating it at 0', async () => {
    await bumpVersionRow(driver(), 'helper_version', { domain: 'x' });
    await Promise.all([bumpVersionRow(driver(), 'helper_version', { domain: 'x' }), bumpVersionRow(driver(), 'helper_version', { domain: 'y' })]);
    const rows = (await driver().select().from('helper_version').orderBy('domain').asRaw<any[]>()) as { domain: string; version: number }[];
    expect(rows).to.deep.equal([
      { domain: 'x', version: 2 },
      { domain: 'y', version: 1 },
    ]);
  });

  it('runs a fragment as a raw where', async () => {
    await insertChunked(driver(), 'helper_item', [
      { type: 'a', id: '1', n: 1 },
      { type: 'b', id: '1', n: 2 },
    ]);
    const where = sql.or([sql`type = ${'b'}`, sql`n IN (${[7, 8]})`]);
    const rows = (await driver().select().from('helper_item').where(toRawQuery(where)).asRaw<any[]>()) as { n: number }[];
    expect(rows.map((r) => r.n)).to.deep.equal([2]);
  });
});
