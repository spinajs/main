import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { ColumnRef, Connection, DateTime as DateTimeColumn, InvalidCursor, Model, ModelBase, OrmDriver, Primary } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import fc from 'fast-check';
import { DateTime } from 'luxon';
import 'mocha';
import { db } from './common.js';
import { bootUow, registerUowConnection, UowOrder } from './uowFixture.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

@Connection('sqlite')
@Model('ks_item')
class KsItem extends ModelBase {
  @Primary()
  public Id: number;

  public Score: number;

  public Name: string;

  @DateTimeColumn()
  public At: DateTime;

  /** Nullable on purpose: the one column `paginate()` must refuse. */
  public Note: string | null;
}

type Order = Array<[ColumnRef<KsItem>, 'asc' | 'desc']>;

const EPOCH = DateTime.fromISO('2026-01-01T00:00:00.000Z', { zone: 'utc' });

function sqlite(): OrmDriver {
  return db().Connections.get('sqlite')!;
}

async function insertItems(items: Array<{ score: number; name: string }>): Promise<void> {
  if (items.length !== 0) {
    await sqlite()
      .insert()
      .into('ks_item')
      .values(items.map((i) => ({ Score: i.score, Name: i.name, At: EPOCH })));
  }
}

async function walk(orderBy: Order, limit: number, between?: () => Promise<void>): Promise<number[]> {
  const seen: number[] = [];
  let after: string | undefined;

  for (let pages = 0; pages < 500; pages++) {
    const page = await KsItem.select().paginate({ orderBy, limit, after });
    seen.push(...page.items.map((i) => i.Id));
    if (between) {
      await between();
    }
    if (page.next === null) {
      return seen;
    }
    after = page.next;
  }

  throw new Error('the walk did not end within 500 pages');
}

/** `cursor` with its first order value replaced: the order hash still matches, so only the value checks can refuse it. */
function withFirstValue(cursor: string, value: unknown): string {
  const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { h: string; v: unknown[] };
  payload.v[0] = value;
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

async function sortedIds(orderBy: Order): Promise<number[]> {
  let query = KsItem.select();
  for (const [column, direction] of orderBy) {
    query = direction === 'asc' ? query.order(column) : query.orderByDescending(column);
  }
  return (await query.order('Id')).map((i) => i.Id);
}

describe('paginate() on sqlite', function () {
  this.timeout(120000);

  before(() => registerUowConnection());
  beforeEach(async () => {
    await bootUow();
    await sqlite()
      .schema()
      .createTable('ks_item', (t) => {
        t.int('Id').primaryKey().autoIncrement();
        t.int('Score').notNull();
        t.string('Name').notNull();
        t.dateTime('At').notNull();
        t.string('Note');
      });
    await db().reloadTableInfo();
  });
  afterEach(() => DI.clearCache());

  it('walks every row once with a mixed-direction order', async () => {
    await insertItems(Array.from({ length: 25 }, (_, i) => ({ score: i % 5, name: String.fromCharCode(97 + (i % 3)) })));
    const orderBy: Order = [
      ['Score', 'desc'],
      ['Name', 'asc'],
    ];

    expect(await walk(orderBy, 4)).to.deep.equal(await sortedIds(orderBy));
  });

  it('walks back from the last page through previous', async () => {
    await insertItems(Array.from({ length: 10 }, (_, i) => ({ score: i % 3, name: 'x' })));
    const orderBy: Order = [['Score', 'asc']];

    let page = await KsItem.select().paginate({ orderBy, limit: 3 });
    expect(page.previous).to.eq(null);
    while (page.next !== null) {
      page = await KsItem.select().paginate({ orderBy, limit: 3, after: page.next });
    }

    const backwards = page.items.map((i) => i.Id);
    while (page.previous !== null) {
      page = await KsItem.select().paginate({ orderBy, limit: 3, before: page.previous });
      backwards.unshift(...page.items.map((i) => i.Id));
    }

    expect(backwards).to.deep.equal(await sortedIds(orderBy));
  });

  it('pages by a datetime column with ties', async () => {
    await sqlite()
      .insert()
      .into('ks_item')
      .values(Array.from({ length: 9 }, (_, i) => ({ Score: 0, Name: 'd', At: EPOCH.plus({ minutes: i % 3 }) })));
    const orderBy: Order = [['At', 'desc']];

    expect(await walk(orderBy, 2)).to.deep.equal(await sortedIds(orderBy));
  });

  it('refuses a cursor made for another order', async () => {
    await insertItems([
      { score: 1, name: 'a' },
      { score: 2, name: 'b' },
    ]);
    const page = await KsItem.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 });

    await expect(KsItem.select().paginate({ orderBy: [['Score', 'desc']], limit: 1, after: page.next! })).to.be.rejectedWith(InvalidCursor);
  });

  it('refuses a cursor that is not a page cursor', async () => {
    await expect(KsItem.select().paginate({ orderBy: [['Score', 'asc']], limit: 1, after: 'AAAA' })).to.be.rejectedWith(InvalidCursor);
  });

  it('accepts a crafted start position: the cursor is spec-checked, not signed, and where() still bounds the rows', async () => {
    await insertItems(Array.from({ length: 6 }, (_, i) => ({ score: i, name: 'x' })));
    const page = await KsItem.select().paginate({ orderBy: [['Score', 'asc']], limit: 2 });
    const payload = JSON.parse(Buffer.from(page.next!, 'base64url').toString('utf8')) as { h: string; v: unknown[] };
    // a position no row holds: past Score 3 whatever its Id
    payload.v = [3, 99];
    const crafted = Buffer.from(JSON.stringify(payload)).toString('base64url');

    const moved = await KsItem.select().paginate({ orderBy: [['Score', 'asc']], limit: 10, after: crafted });
    expect(moved.items.map((i) => i.Score)).to.deep.equal([4, 5]);

    const bounded = await KsItem.where('Score', '<', 5).paginate({ orderBy: [['Score', 'asc']], limit: 10, after: crafted });
    expect(bounded.items.map((i) => i.Score)).to.deep.equal([4]);
  });

  it('refuses a cursor value the order column cannot hold, before it reaches SQL', async () => {
    await insertItems([
      { score: 1, name: 'a' },
      { score: 2, name: 'b' },
    ]);
    const { next } = await KsItem.select().paginate({ orderBy: [['Score', 'asc']], limit: 1 });

    for (const value of ['abc', 1.5, true, { $d: '2020-01-01' }, { $b: '99999999999999999999999' }, 'x'.repeat(2 * 1024 * 1024)]) {
      await expect(KsItem.select().paginate({ orderBy: [['Score', 'asc']], limit: 1, after: withFirstValue(next!, value) }), JSON.stringify(value).slice(0, 40)).to.be.rejectedWith(InvalidCursor);
    }
  });

  it('adds the order columns to a narrowed select and walks every page', async () => {
    await insertItems(Array.from({ length: 10 }, (_, i) => ({ score: i % 4, name: 'x' })));
    const ids: number[] = [];
    let after: string | undefined;

    for (let pages = 0; pages < 20; pages++) {
      const page = await KsItem.query().select('Id').paginate({ orderBy: [['Score', 'desc']], limit: 3, after });
      ids.push(...page.items.map((i) => i.Id));
      if (page.next === null) {
        break;
      }
      after = page.next;
    }

    expect(ids).to.deep.equal(await sortedIds([['Score', 'desc']]));
  });

  it('refuses an order by a relation column as a bad argument', async () => {
    await expect(UowOrder.select().paginate({ orderBy: [['Client.Name', 'asc']], limit: 1 })).to.be.rejectedWith(InvalidArgument, /relation/);
  });

  it('refuses a nullable order column before the first page', async () => {
    await insertItems([{ score: 1, name: 'a' }]);

    await expect(KsItem.select().paginate({ orderBy: [['Note', 'asc']], limit: 1 })).to.be.rejectedWith(InvalidArgument, /NOT NULL/);
  });

  it('refuses a query that already has an order', async () => {
    await expect(KsItem.select().order('Id').paginate({ orderBy: [['Score', 'asc']], limit: 1 })).to.be.rejectedWith(InvalidOperation);
  });

  it('yields every row present before the walk exactly once while rows are inserted between pages', async () => {
    const item = fc.record({ score: fc.integer({ min: 0, max: 4 }), name: fc.constantFrom('a', 'b', 'c') });
    const orders: Order[] = [
      [['Score', 'asc']],
      [
        ['Score', 'desc'],
        ['Name', 'asc'],
      ],
      [
        ['Name', 'desc'],
        ['Score', 'asc'],
      ],
    ];

    await fc.assert(
      fc.asyncProperty(fc.array(item, { minLength: 1, maxLength: 40 }), fc.array(item, { maxLength: 20 }), fc.integer({ min: 1, max: 7 }), fc.constantFrom(...orders), async (initial, inserted, limit, orderBy) => {
        await sqlite().truncate('ks_item');
        await insertItems(initial);
        const present = (await KsItem.select()).map((i) => i.Id);
        const pending = [...inserted];

        const seen = await walk(orderBy, limit, () => insertItems(pending.splice(0, 2)));

        expect(new Set(seen).size).to.eq(seen.length);
        for (const id of present) {
          expect(seen).to.include(id);
        }
      }),
      { numRuns: 40 },
    );
  });
});
