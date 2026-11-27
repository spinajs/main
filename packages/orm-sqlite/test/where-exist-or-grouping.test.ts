import { DI } from '@spinajs/di';
// Relation and SingleRelation are value imports: the decorators read them from the emitted property types.
import { BelongsTo, Connection, HasMany, Model, ModelBase, Primary, QueryContext, Relation, SingleRelation, SoftDelete } from '@spinajs/orm';
import type { ICompilerOutput, IWhereBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import { SqliteOrmDriver } from '../src/index.js';
import { db } from './common.js';
import { bootUow, registerUowConnection, UowClient, UowOrder, UowOrderItem } from './uowFixture.js';

@Connection('sqlite')
@Model('weg_owner')
class WegOwner extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany('WegNote', { foreignKey: 'owner_id', primaryKey: 'Id' })
  public Notes: Relation<WegNote, WegOwner>;
}

@Connection('sqlite')
@Model('weg_note')
class WegNote extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  public owner_id: number;

  @SoftDelete()
  public DeletedAt: DateTime;

  @BelongsTo(WegOwner, 'owner_id', 'Id')
  public Owner: SingleRelation<WegOwner>;
}

const ids = (rows: ReadonlyArray<{ Id: number }>) => rows.map((r) => Number(r.Id)).sort((a, b) => a - b);

function sql(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): string {
  const out = query.toDB();
  return String((Array.isArray(out) ? out[0] : out).expression);
}

/** The rows of a hand-written query that correlates first and groups the callback's OR. */
async function correct(statement: string): Promise<number[]> {
  const driver = db().Connections.get('sqlite');
  if (!(driver instanceof SqliteOrmDriver)) throw new Error('the sqlite connection is not registered');
  return ids((await driver.executeOnDb(statement, [], QueryContext.Select)) as { Id: number }[]);
}

const bOrQ = function (this: IWhereBuilder<unknown>) {
  this.where('Sku', 'B').orWhere('Sku', 'Q');
};
const total20Or999 = function (this: IWhereBuilder<unknown>) {
  this.where('Total', 20).orWhere('Total', 999);
};
const bOrZz = function (this: IWhereBuilder<unknown>) {
  this.where('Title', 'b').orWhere('Title', 'zz');
};

const ITEMS_B_OR_Q = "SELECT 1 FROM uow_order_item x WHERE x.order_id = o.Id AND (x.Sku = 'B' OR x.Sku = 'Q')";
const ORDER_20_OR_999 = 'SELECT 1 FROM uow_order x WHERE x.Id = i.order_id AND (x.Total = 20 OR x.Total = 999)';
const LIVE_NOTES_B_OR_ZZ = "SELECT 1 FROM weg_note x WHERE x.DeletedAt IS NULL AND x.owner_id = w.Id AND (x.Title = 'b' OR x.Title = 'zz')";

// Recorded on the parent branch: a callback without a top-level OR compiles as it did.
const AND_ONLY = {
  hasMany: 'SELECT * FROM `uow_order` WHERE `Id` > ? AND EXISTS ( SELECT * FROM `uow_order_item` as `uow_order_item_exists` WHERE `uow_order_item_exists`.`Sku` = ? AND `uow_order_item_exists`.`order_id` = `uow_order`.`Id` )',
  hasManyNoCallback: 'SELECT * FROM `uow_order` WHERE EXISTS ( SELECT * FROM `uow_order_item` as `uow_order_item_exists` WHERE `uow_order_item_exists`.`order_id` = `uow_order`.`Id` )',
  hasManySingleOrWhere: 'SELECT * FROM `uow_order` WHERE EXISTS ( SELECT * FROM `uow_order_item` as `uow_order_item_exists` WHERE `uow_order_item_exists`.`Sku` = ? AND `uow_order_item_exists`.`order_id` = `uow_order`.`Id` )',
  hasManyNestedGroup: 'SELECT * FROM `uow_order` WHERE EXISTS ( SELECT * FROM `uow_order_item` as `uow_order_item_exists` WHERE ( `uow_order_item_exists`.`Sku` = ? OR `uow_order_item_exists`.`Sku` = ? ) AND `uow_order_item_exists`.`order_id` = `uow_order`.`Id` )',
  hasManyNotExists: 'SELECT * FROM `uow_order` WHERE NOT EXISTS ( SELECT * FROM `uow_order_item` as `uow_order_item_exists` WHERE `uow_order_item_exists`.`Sku` = ? AND `uow_order_item_exists`.`order_id` = `uow_order`.`Id` )',
  belongsTo: 'SELECT * FROM `uow_order_item` WHERE `order_id` IS NOT NULL AND EXISTS ( SELECT * FROM `uow_order` as `uow_order_exists` WHERE `uow_order_exists`.`Total` = ? AND `uow_order_exists`.`Id` = `uow_order_item`.`order_id` )',
  belongsToNestedGroup: 'SELECT * FROM `uow_order_item` WHERE `order_id` IS NOT NULL AND EXISTS ( SELECT * FROM `uow_order` as `uow_order_exists` WHERE ( `uow_order_exists`.`Total` = ? OR `uow_order_exists`.`Total` = ? ) AND `uow_order_exists`.`Id` = `uow_order_item`.`order_id` )',
  softDelete: 'SELECT * FROM `weg_owner` WHERE EXISTS ( SELECT * FROM `weg_note` as `weg_note_exists` WHERE `weg_note_exists`.`DeletedAt` IS NULL AND `weg_note_exists`.`Title` = ? AND `weg_note_exists`.`owner_id` = `weg_owner`.`Id` )',
  manyToManyOr: 'SELECT * FROM `uow_order` WHERE EXISTS ( SELECT * FROM `uow_order_tag` as `uow_order_tag_exists` RIGHT JOIN `uow_tag` as `$UowTag$` ON `uow_order_tag_exists`.`tag_id` = `$UowTag$`.`Id` AND ( `$UowTag$`.`Name` = ? OR `$UowTag$`.`Name` = ? ) WHERE `uow_order_tag_exists`.`order_id` = `uow_order`.`Id` )',
};

// Orders 1-5 total 10, 20, 10, 30, 40 (clients 1, 2, 1, 2, 1); items 1 A/o1, 2 B/o2, 3 A/o3, 4 A/o4, 5 Z/o5;
// tags x on order 1, y on order 2. Owner 1 has notes a and b (deleted), owner 2 has note b.
describe('an OR in a whereExist / whereNotExists callback keeps the correlation', function () {
  this.timeout(30000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    const sqlite = db().Connections.get('sqlite')!;
    const schema = sqlite.schema();
    await schema.createTable('weg_owner', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
    });
    await schema.createTable('weg_note', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Title');
      t.int('owner_id');
      t.dateTime('DeletedAt');
    });
    await db().reloadTableInfo();

    await UowClient.insert({ Name: 'acme' });
    await UowClient.insert({ Name: 'globex' });
    for (const [Total, client_id] of [[10, 1], [20, 2], [10, 1], [30, 2], [40, 1]]) {
      await UowOrder.insert({ Total, client_id });
    }
    for (const [Sku, order_id] of [['A', 1], ['B', 2], ['A', 3], ['A', 4], ['Z', 5]] as const) {
      await UowOrderItem.insert({ Sku, Qty: 1, order_id });
    }
    await sqlite.insert().into('uow_tag').values([
      { Id: 1, Name: 'x' },
      { Id: 2, Name: 'y' },
    ]);
    await sqlite.insert().into('uow_order_tag').values([
      { order_id: 1, tag_id: 1 },
      { order_id: 2, tag_id: 2 },
    ]);
    await sqlite.insert().into('weg_owner').values([
      { Id: 1, Name: 'one' },
      { Id: 2, Name: 'two' },
    ]);
    await sqlite
      .insert()
      .into('weg_note')
      .values([
        { Id: 1, Title: 'a', owner_id: 1, DeletedAt: null },
        { Id: 2, Title: 'b', owner_id: 1, DeletedAt: DateTime.utc().toISO() },
        { Id: 3, Title: 'b', owner_id: 2, DeletedAt: null },
      ]);
  });

  afterEach(() => DI.clearCache());

  it('whereExist on a hasMany', async () => {
    expect(ids(await UowOrder.where('Id', 1).whereExist('Items', bOrQ))).to.deep.equal([]);
    expect(ids(await UowOrder.query().whereExist('Items', bOrQ)))
      .to.deep.equal([2])
      .and.to.deep.equal(await correct(`SELECT o.Id FROM uow_order o WHERE EXISTS (${ITEMS_B_OR_Q})`));
  });

  it('whereNotExists on a hasMany', async () => {
    expect(ids(await UowOrder.query().whereNotExists('Items', bOrQ)))
      .to.deep.equal([1, 3, 4, 5])
      .and.to.deep.equal(await correct(`SELECT o.Id FROM uow_order o WHERE NOT EXISTS (${ITEMS_B_OR_Q})`));
  });

  it('whereExist on a belongsTo', async () => {
    expect(ids(await UowOrderItem.query().whereExist('Order', total20Or999)))
      .to.deep.equal([2])
      .and.to.deep.equal(await correct(`SELECT i.Id FROM uow_order_item i WHERE EXISTS (${ORDER_20_OR_999})`));
  });

  it('whereNotExists on a belongsTo', async () => {
    expect(ids(await UowOrderItem.query().whereNotExists('Order', total20Or999)))
      .to.deep.equal([1, 3, 4, 5])
      .and.to.deep.equal(await correct(`SELECT i.Id FROM uow_order_item i WHERE NOT EXISTS (${ORDER_20_OR_999})`));
  });

  it('whereExist and whereNotExists on a soft-delete target', async () => {
    expect(ids(await WegOwner.query().whereExist('Notes', bOrZz)))
      .to.deep.equal([2])
      .and.to.deep.equal(await correct(`SELECT w.Id FROM weg_owner w WHERE EXISTS (${LIVE_NOTES_B_OR_ZZ})`));
    expect(ids(await WegOwner.query().whereNotExists('Notes', bOrZz)))
      .to.deep.equal([1])
      .and.to.deep.equal(await correct(`SELECT w.Id FROM weg_owner w WHERE NOT EXISTS (${LIVE_NOTES_B_OR_ZZ})`));
  });

  it('a whereExist inside a lazy populate callback', async () => {
    const client = await UowClient.where('Id', 1).firstOrFail();
    await client.Orders.populate(function () {
      this.whereExist('Items', bOrQ);
    });

    expect(ids([...client.Orders])).to.deep.equal([]);
  });

  it('a clone, taken before or after the original compiles', async () => {
    const query = UowOrder.where('Id', 1).whereExist('Items', bOrQ);
    const early = query.clone();
    expect(ids(await query)).to.deep.equal([]);
    const late = query.clone();

    expect(sql(late)).to.eq(sql(query));
    expect(ids(await early)).to.deep.equal([]);
    expect(ids(await late)).to.deep.equal([]);
  });

  it('compiles the callback as a group before the correlation', () => {
    expect(sql(UowOrder.where('Id', 1).whereExist('Items', bOrQ))).to.contain(
      'WHERE ( `uow_order_item_exists`.`Sku` = ? OR `uow_order_item_exists`.`Sku` = ? ) AND `uow_order_item_exists`.`order_id` = `uow_order`.`Id` )',
    );
    expect(sql(WegOwner.query().whereExist('Notes', bOrZz))).to.contain(
      'WHERE `weg_note_exists`.`DeletedAt` IS NULL AND ( `weg_note_exists`.`Title` = ? OR `weg_note_exists`.`Title` = ? ) AND `weg_note_exists`.`owner_id` = `weg_owner`.`Id` )',
    );
  });

  it('keeps the SQL of a callback without a top-level OR, and of a many-to-many', () => {
    expect(
      sql(
        UowOrder.where('Id', '>', 0).whereExist('Items', function () {
          this.where('Sku', 'B');
        }),
      ),
    ).to.eq(AND_ONLY.hasMany);
    expect(sql(UowOrder.query().whereExist('Items'))).to.eq(AND_ONLY.hasManyNoCallback);
    expect(
      sql(
        UowOrder.query().whereExist('Items', function () {
          this.orWhere('Sku', 'B');
        }),
      ),
    ).to.eq(AND_ONLY.hasManySingleOrWhere);
    expect(
      sql(
        UowOrder.query().whereExist('Items', function () {
          this.where(bOrQ);
        }),
      ),
    ).to.eq(AND_ONLY.hasManyNestedGroup);
    expect(
      sql(
        UowOrder.query().whereNotExists('Items', function () {
          this.where('Sku', 'A');
        }),
      ),
    ).to.eq(AND_ONLY.hasManyNotExists);
    expect(
      sql(
        UowOrderItem.query().whereExist('Order', function () {
          this.where('Total', 10);
        }),
      ),
    ).to.eq(AND_ONLY.belongsTo);
    expect(
      sql(
        UowOrderItem.query().whereExist('Order', function () {
          this.where(total20Or999);
        }),
      ),
    ).to.eq(AND_ONLY.belongsToNestedGroup);
    expect(
      sql(
        WegOwner.query().whereExist('Notes', function () {
          this.where('Title', 'b');
        }),
      ),
    ).to.eq(AND_ONLY.softDelete);
    expect(
      sql(
        UowOrder.query().whereExist('Tags', function () {
          this.where('Name', 'x').orWhere('Name', 'zz');
        }),
      ),
    ).to.eq(AND_ONLY.manyToManyOr);
  });

  it('a many-to-many keeps its rows', async () => {
    const xOrZz = function (this: IWhereBuilder<unknown>) {
      this.where('Name', 'x').orWhere('Name', 'zz');
    };
    expect(ids(await UowOrder.query().whereExist('Tags', xOrZz))).to.deep.equal([1]);
    expect(ids(await UowOrder.query().whereNotExists('Tags', xOrZz))).to.deep.equal([2, 3, 4, 5]);
  });
});
