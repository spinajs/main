import { Connection, Model, ModelBase, OrmDriver, Primary, RawQuery, SoftDelete } from '@spinajs/orm';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import sinon from 'sinon';
import { SqliteOrmDriver } from '../src/index.js';
import { db } from './common.js';
import { bootUow, registerUowConnection } from './uowFixture.js';

const expect = chai.expect;

@Connection('sqlite')
@Model('ko_item')
class KoItem extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  public Score: number;
}

@Connection('sqlite')
@Model('ko_soft')
class KoSoft extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  public Score: number;

  @SoftDelete()
  public DeletedAt: DateTime;
}

interface Row {
  Id: number;
}

type Order = Array<[string, 'asc' | 'desc']>;

// `a` matches rows on every page, so a predicate the OR captures brings them back on every page.
const ROWS = [
  { Id: 1, Title: 'a', Score: 3 },
  { Id: 2, Title: 'b', Score: 1 },
  { Id: 3, Title: 'a', Score: 2 },
  { Id: 4, Title: 'c', Score: 3 },
  { Id: 5, Title: 'a', Score: 1 },
  { Id: 6, Title: 'b', Score: 3 },
  { Id: 7, Title: 'a', Score: 2 },
  { Id: 8, Title: 'c', Score: 1 },
];
const DELETED = [
  { Id: 9, Title: 'a', Score: 2 },
  { Id: 10, Title: 'b', Score: 3 },
];

// a regression must fail on the rows, not hang the suite
const ROW_CAP = 30;
const PAGE_CAP = 20;

function sqlite(): OrmDriver {
  return db().Connections.get('sqlite')!;
}

const ids = (rows: Row[]): number[] => rows.map((r) => r.Id);

async function streamed<R extends Row>(query: ISelectQueryBuilder<R[]>, batchSize: number): Promise<number[]> {
  const seen: number[] = [];
  for await (const row of query.stream({ batchSize })) {
    seen.push(row.Id);
    if (seen.length > ROW_CAP) break;
  }
  return seen;
}

async function paged<R extends Row>(query: () => ISelectQueryBuilder<R[]>, orderBy: Order, limit: number): Promise<number[]> {
  const seen: number[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < PAGE_CAP; pages++) {
    const page = await query().paginate({ orderBy, limit, after });
    seen.push(...ids(page.items));
    if (page.next === null) break;
    after = page.next;
  }
  return seen;
}

function sorted<R>(query: ISelectQueryBuilder<R[]>, orderBy: Order): ISelectQueryBuilder<R[]> {
  for (const [column, direction] of orderBy) {
    query = direction === 'asc' ? query.order(column) : query.orderByDescending(column);
  }
  return query;
}

const plainOr = () => KoItem.where('Title', 'a').orWhere('Title', 'b');
const scopedOr = () => KoSoft.where('Title', 'a').orWhere('Title', 'b');
const rawOr = () => KoItem.where(RawQuery.create("`Title` = 'a' OR `Title` = 'b'"));

const ORDERS: Array<[string, Order]> = [
  ['the key ascending', [['Id', 'asc']]],
  ['a composite key', [['Score', 'desc'], ['Title', 'asc']]],
  ['the key descending', [['Id', 'desc']]],
];

describe('keyset pages of a query with a top-level OR', function () {
  this.timeout(60000);
  const sandbox = sinon.createSandbox();

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    for (const table of ['ko_item', 'ko_soft']) {
      await sqlite()
        .schema()
        .createTable(table, (t) => {
          t.int('Id').primaryKey().autoIncrement();
          t.string('Title').notNull();
          t.int('Score').notNull();
          if (table === 'ko_soft') t.dateTime('DeletedAt');
        });
    }
    await db().reloadTableInfo();
    await sqlite().insert().into('ko_item').values(ROWS);
    const stamp = DateTime.utc().toISO();
    await sqlite()
      .insert()
      .into('ko_soft')
      .values([...ROWS.map((r) => ({ ...r, DeletedAt: null })), ...DELETED.map((r) => ({ ...r, DeletedAt: stamp }))]);
    executed = sandbox.spy(SqliteOrmDriver.prototype, 'executeOnDb');
  });
  afterEach(() => {
    sandbox.restore();
    DI.clearCache();
  });

  let executed: sinon.SinonSpy<Parameters<SqliteOrmDriver['executeOnDb']>, ReturnType<SqliteOrmDriver['executeOnDb']>>;

  /** The SELECT statements sqlite ran on `table` in this test, in order. */
  function selects(table: string): () => string[] {
    return () =>
      executed
        .getCalls()
        .map((c) => c.args[0])
        .filter((sql) => sql.startsWith('SELECT') && sql.includes(`\`${table}\``));
  }

  function walks<R extends Row>(model: string, orOf: () => ISelectQueryBuilder<R[]>): void {
    for (const [name, orderBy] of ORDERS) {
      it(`stream() ends and yields each row once, ordered by ${name}, on ${model}`, async () => {
        const expected = ids(await sorted(orOf(), orderBy));
        expect(expected).to.have.length(6);

        expect(await streamed(sorted(orOf(), orderBy), 2)).to.deep.eq(expected);
      });

      it(`paginate() returns each row once over all pages, ordered by ${name}, on ${model}`, async () => {
        const expected = ids(await sorted(orOf(), orderBy));

        expect(await paged(orOf, orderBy, 2)).to.deep.eq(expected);
      });
    }
  }

  walks('a model without scopes', plainOr);
  walks('a soft-delete model', scopedOr);

  it('soft-deleted rows stay out of every page', async () => {
    const deleted = DELETED.map((r) => r.Id);
    expect(await streamed(scopedOr().order('Id'), 1)).to.not.include.members(deleted);
    expect(await paged(scopedOr, [['Score', 'desc']], 1)).to.not.include.members(deleted);
  });

  it('a raw OR pages each row once', async () => {
    expect(await streamed(rawOr().order('Id'), 2)).to.deep.eq([1, 2, 3, 5, 6, 7]);
    expect(await paged(rawOr, [['Id', 'asc']], 2)).to.deep.eq([1, 2, 3, 5, 6, 7]);
  });

  it('compiles the keyset predicate after the bracketed OR', async () => {
    const plain = selects('ko_item');
    const scoped = selects('ko_soft');
    await streamed(plainOr().order('Id'), 4);
    expect(plain()[1]).to.eq('SELECT * FROM `ko_item` WHERE ( `Title` = ? OR `Title` = ? ) AND ( ( `Id` > ? ) ) ORDER BY `Id` ASC LIMIT ?');

    await paged(scopedOr, [['Score', 'desc']], 4);
    expect(scoped()[1]).to.eq(
      'SELECT * FROM `ko_soft` WHERE `DeletedAt` IS NULL AND ( `Title` = ? OR `Title` = ? ) AND ( ( `Score` < ? ) OR ( `Score` = ? AND `Id` > ? ) ) ORDER BY `Score` DESC, `Id` ASC LIMIT ?',
    );
  });

  it('compiles a raw OR in brackets before the keyset predicate', async () => {
    const plain = selects('ko_item');
    await streamed(rawOr().order('Id'), 4);
    expect(plain()[1]).to.eq("SELECT * FROM `ko_item` WHERE ( `Title` = 'a' OR `Title` = 'b' ) AND ( ( `Id` > ? ) ) ORDER BY `Id` ASC LIMIT ?");
  });

  // literal strings recorded on the base, before the fix
  it('keeps the SQL of a group the query bracketed itself', async () => {
    const plain = selects('ko_item');
    const grouped = KoItem.where(function () {
      this.where('Title', 'a').orWhere('Title', 'b');
    });
    expect(await streamed(grouped.order('Id'), 4)).to.deep.eq([1, 2, 3, 5, 6, 7]);
    expect(plain()[1]).to.eq('SELECT * FROM `ko_item` WHERE ( `Title` = ? OR `Title` = ? ) AND ( ( `Id` > ? ) ) ORDER BY `Id` ASC LIMIT ?');
  });

  it('keeps the SQL of an AND-only query', async () => {
    const plain = selects('ko_item');
    const scoped = selects('ko_soft');
    await streamed(KoItem.where('Score', '>', 0).order('Id'), 4);
    expect(plain()[1]).to.eq('SELECT * FROM `ko_item` WHERE `Score` > ? AND ( ( `Id` > ? ) ) ORDER BY `Id` ASC LIMIT ?');

    await paged(() => KoSoft.where('Score', '>', 0), [['Score', 'desc']], 4);
    expect(scoped()[1]).to.eq('SELECT * FROM `ko_soft` WHERE `DeletedAt` IS NULL AND `Score` > ? AND ( ( `Score` < ? ) OR ( `Score` = ? AND `Id` > ? ) ) ORDER BY `Score` DESC, `Id` ASC LIMIT ?');
  });
});
