import { DI } from '@spinajs/di';
// Relation and SingleRelation are value imports: the decorators read them from the emitted property types.
import { BelongsTo, Connection, HasMany, Model, ModelBase, Primary, RawQuery, Relation, SingleRelation, SoftDelete } from '@spinajs/orm';
import type { ICompilerOutput } from '@spinajs/orm';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import 'mocha';
import { db } from './common.js';
import { bootUow, captureStatements, registerUowConnection, UowClient, UowOrder, UowOrderItem } from './uowFixture.js';

@Connection('sqlite')
@Model('pcg_owner')
class PcgOwner extends ModelBase {
  @Primary()
  public Id: number;

  public Name: string;

  @HasMany('PcgNote', { foreignKey: 'owner_id', primaryKey: 'Id' })
  public Notes: Relation<PcgNote, PcgOwner>;
}

@Connection('sqlite')
@Model('pcg_note')
class PcgNote extends ModelBase {
  @Primary()
  public Id: number;

  public Title: string;

  public owner_id: number;

  @SoftDelete()
  public DeletedAt: DateTime;

  @BelongsTo(PcgOwner, 'owner_id', 'Id')
  public Owner: SingleRelation<PcgOwner>;
}

function sql(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): string {
  const out = query.toDB();
  return String((Array.isArray(out) ? out[0] : out).expression);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of source) {
    out.push(row);
  }
  return out;
}

const skus = (rows: UowOrderItem[]) => rows.map((r) => r.Sku);

/** No item has Sku NOPE; the callback's OR matches order 1, which item A belongs to. */
function noItemWithOrOrder() {
  return UowOrderItem.where('Sku', 'NOPE')
    .order('Id')
    .populate('Order', function () {
      this.where('Total', 999).orWhere('Total', 10);
    });
}

describe('belongsTo populate callback conditions', function () {
  this.timeout(30000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowClient.insert({ Name: 'globex' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
    await UowOrder.insert({ Total: 20, client_id: 2 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowOrderItem.insert({ Sku: 'B', Qty: 1, order_id: 2 });
  });

  afterEach(() => DI.clearCache());

  it('an orWhere in the callback does not widen the parent query', async () => {
    const capture = captureStatements();
    const rows = await noItemWithOrOrder();
    capture.restore();

    expect(skus(rows)).to.deep.equal([]);
    expect(capture.statements[0].expression).to.contain('WHERE `$UowOrderItem$`.`Sku` = ? AND ( `$Order$`.`Total` = ? OR `$Order$`.`Total` = ? )');
    expect(capture.statements[0].bindings).to.deep.equal(['NOPE', 999, 10]);
  });

  it('an orWhere in the callback still narrows the rows to the related rows it matches', async () => {
    const rows = await UowOrderItem.where('Qty', 1)
      .order('Id')
      .populate('Order', function () {
        this.where('Total', 999).orWhere('Total', 10);
      });

    expect(skus(rows)).to.deep.equal(['A']);
    expect(rows[0].Order.Value.Total).to.eq(10);
  });

  it('a nested belongsTo callback keeps a group of its own, ANDed to the parent query', async () => {
    const query = UowOrderItem.where('Sku', 'NOPE').populate('Order', function () {
      this.populate('Client', function () {
        this.where('Name', 'none').orWhere('Name', 'acme');
      });
    });

    expect(sql(query)).to.contain('WHERE `$UowOrderItem$`.`Sku` = ? AND ( `$Order$.$Client$`.`Name` = ? OR `$Order$.$Client$`.`Name` = ? )');
    expect(skus(await query)).to.deep.equal([]);
  });

  it('a clone keeps the group, taken before or after the original compiles', async () => {
    const query = noItemWithOrOrder();
    const early = query.clone();
    expect(skus(await query)).to.deep.equal([]);
    const late = query.clone();

    expect(sql(late)).to.eq(sql(query));
    expect(skus(await early)).to.deep.equal([]);
    expect(skus(await late)).to.deep.equal([]);
  });

  it('a clone taken after compile qualifies a nested whereColumn() with the nested alias', async () => {
    const query = UowOrderItem.where('Sku', 'A').populate('Order', function () {
      this.populate('Client', function () {
        this.whereColumn('Id', '=', 'Id');
      });
    });
    const compiled = sql(query);
    const late = query.clone();

    expect(compiled).to.contain('`$Order$.$Client$`.`Id` = `$Order$.$Client$`.`Id`');
    expect(sql(late)).to.eq(compiled);
    expect(skus(await late)).to.deep.equal(['A']);
  });

  it('every keyset page of a stream keeps the group', async () => {
    expect(skus(await collect(noItemWithOrOrder().stream({ batchSize: 1 })))).to.deep.equal([]);

    const narrowed = UowOrderItem.where('Qty', 1)
      .order('Id')
      .populate('Order', function () {
        this.where('Total', 999).orWhere('Total', 10);
      });
    expect(skus(await collect(narrowed.stream({ batchSize: 1 })))).to.deep.equal(['A']);
  });
});

const ids = (rows: ReadonlyArray<{ Id: number }>) => rows.map((r) => r.Id);

// recorded on the base, before the relation conditions were flagged
const AND_ONLY_EAGER =
  'SELECT `$UowOrderItem$`.*,`$Order$`.`Id` as `$Order$.Id`,`$Order$`.`Total` as `$Order$.Total`,`$Order$`.`client_id` as `$Order$.client_id` FROM `uow_order_item` as `$UowOrderItem$` LEFT JOIN `uow_order` as `$Order$` ON `$UowOrderItem$`.`order_id` = `$Order$`.`Id` WHERE `$UowOrderItem$`.`Sku` = ? AND ( `$Order$`.`Total` = ? OR `$Order$`.`Total` = ? )';
const AND_ONLY_LAZY = 'SELECT * FROM `uow_order_item` WHERE `order_id` = ? AND `Sku` = ?';
const LAZY_BELONGS_TO_WHERE = 'FROM `uow_order` WHERE `Id` = ? AND ( `Total` = ? OR `Total` = ? ) LIMIT ?';
const LAZY_HAS_MANY_WHERE = 'FROM `uow_order_item` WHERE `order_id` = ? AND ( `Sku` = ? OR `Sku` = ? )';

// Orders 1 and 3 total 10 (acme), 2 totals 20 and 4 totals 30 (globex); items 1 A/o1, 2 B/o2, 3 A/o3, 4 A/o4.
// Owner 1 has notes 1 (a) and 2 (a, deleted), owner 2 notes 3 (b) and 4 (b, deleted).
describe('the relation condition stays outside an OR of the application', function () {
  this.timeout(30000);

  before(() => registerUowConnection());

  beforeEach(async () => {
    await bootUow();
    const schema = db().Connections.get('sqlite')!.schema();
    await schema.createTable('pcg_owner', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Name');
    });
    await schema.createTable('pcg_note', (t) => {
      t.int('Id').primaryKey().autoIncrement();
      t.string('Title');
      t.int('owner_id');
      t.dateTime('DeletedAt');
    });
    await db().reloadTableInfo();

    await UowClient.insert({ Name: 'acme' });
    await UowClient.insert({ Name: 'globex' });
    for (const [Total, client_id] of [[10, 1], [20, 2], [10, 1], [30, 2]]) {
      await UowOrder.insert({ Total, client_id });
    }
    for (const [Sku, order_id] of [['A', 1], ['B', 2], ['A', 3], ['A', 4]] as const) {
      await UowOrderItem.insert({ Sku, Qty: 1, order_id });
    }
    const sqlite = db().Connections.get('sqlite')!;
    const stamp = DateTime.utc().toISO();
    await sqlite.insert().into('pcg_owner').values([
      { Id: 1, Name: 'one' },
      { Id: 2, Name: 'two' },
    ]);
    await sqlite
      .insert()
      .into('pcg_note')
      .values([
        { Id: 1, Title: 'a', owner_id: 1, DeletedAt: null },
        { Id: 2, Title: 'a', owner_id: 1, DeletedAt: stamp },
        { Id: 3, Title: 'b', owner_id: 2, DeletedAt: null },
        { Id: 4, Title: 'b', owner_id: 2, DeletedAt: stamp },
      ]);
  });

  afterEach(() => DI.clearCache());

  const aOrB = () => UowOrderItem.where('Sku', 'A').orWhere('Sku', 'B').order('Id');

  it('belongsTo: a top-level OR of the query does not capture the populate condition', async () => {
    const capture = captureStatements();
    const rows = await aOrB().populate('Order', function () {
      this.where('Total', 20);
    });
    capture.restore();

    expect(ids(rows)).to.deep.equal([2]);
    expect(capture.statements[0].expression).to.contain('WHERE ( `$UowOrderItem$`.`Sku` = ? OR `$UowOrderItem$`.`Sku` = ? ) AND ( `$Order$`.`Total` = ? )');
    expect(capture.statements[0].bindings).to.deep.equal(['A', 'B', 20]);
  });

  it('belongsTo: a raw OR of the query does not capture the populate condition', async () => {
    const rows = await UowOrderItem.where(RawQuery.create("`$UowOrderItem$`.`Sku` = 'A' OR `$UowOrderItem$`.`Sku` = 'B'"))
      .order('Id')
      .populate('Order', function () {
        this.where('Total', 20);
      });

    expect(ids(rows)).to.deep.equal([2]);
  });

  it('belongsTo nested two levels: both groups stay outside the OR of the query', async () => {
    const query = aOrB().populate('Order', function () {
      this.where('Total', '<', 30);
      this.populate('Client', function () {
        this.where('Name', 'none').orWhere('Name', 'globex');
      });
    });

    expect(sql(query)).to.contain('WHERE ( `$UowOrderItem$`.`Sku` = ? OR `$UowOrderItem$`.`Sku` = ? ) AND ( `$Order$`.`Total` < ? ) AND ( `$Order$.$Client$`.`Name` = ? OR `$Order$.$Client$`.`Name` = ? )');
    expect(ids(await query)).to.deep.equal([2]);

    const onlyNested = aOrB().populate('Order', function () {
      this.populate('Client', function () {
        this.where('Name', 'globex');
      });
    });
    expect(ids(await onlyNested)).to.deep.equal([2, 4]);
  });

  it('belongsTo: every keyset page keeps the populate condition outside the OR', async () => {
    const query = aOrB().populate('Order', function () {
      this.where('Total', 20);
    });

    expect(ids(await collect(query.stream({ batchSize: 1 })))).to.deep.equal([2]);
  });

  it('belongsTo: withDeleted() on the query keeps the populate condition', async () => {
    const rows = await PcgNote.query()
      .withDeleted()
      .where('Title', 'a')
      .orWhere('Title', 'b')
      .order('Id')
      .populate('Owner', function () {
        this.where('Name', 'two');
      });

    expect(ids(rows)).to.deep.equal([3, 4]);
  });

  it('keeps the SQL of a query and a populate callback without a top-level OR', () => {
    const query = UowOrderItem.where('Sku', 'A').populate('Order', function () {
      this.where('Total', 10).orWhere('Total', 20);
    });

    expect(sql(query)).to.eq(AND_ONLY_EAGER);
  });

  it('lazy belongsTo: an OR of the callback does not capture the key condition', async () => {
    const item = (await UowOrderItem.where('Id', 2).first())!;
    const capture = captureStatements();
    await item.Order.populate(function () {
      this.where('Total', 20).orWhere('Total', 10);
    });
    capture.restore();

    expect(item.Order.Value?.Id).to.eq(2);
    expect(capture.statements[0].expression).to.contain(LAZY_BELONGS_TO_WHERE);
  });

  it('lazy hasMany: an OR of the callback does not capture the key condition', async () => {
    const order = (await UowOrder.where('Id', 1).first())!;
    const capture = captureStatements();
    await order.Items.populate(function () {
      this.where('Sku', 'A').orWhere('Sku', 'B');
    });
    capture.restore();

    expect(ids(order.Items)).to.deep.equal([1]);
    expect(capture.statements[0].expression).to.contain(LAZY_HAS_MANY_WHERE);
  });

  it('lazy hasMany: a raw OR of the callback does not capture the key condition', async () => {
    const order = (await UowOrder.where('Id', 1).first())!;
    await order.Items.populate(function () {
      this.where(RawQuery.create("Sku = 'A' OR Sku = 'B'"));
    });

    expect(ids(order.Items)).to.deep.equal([1]);
  });

  it('lazy hasMany: withDeleted() in the callback removes the soft-delete filter only, not the key condition', async () => {
    const owner = (await PcgOwner.where('Id', 1).first())!;
    await owner.Notes.populate(function () {
      this.where('Title', 'a').orWhere('Title', 'b');
    });
    expect(ids(owner.Notes)).to.deep.equal([1]);

    await owner.Notes.populate(function () {
      this.withDeleted().where('Title', 'a').orWhere('Title', 'b');
    });
    expect(ids(owner.Notes)).to.deep.equal([1, 2]);
  });

  it('lazy: keeps the SQL of a callback without a top-level OR', async () => {
    const order = (await UowOrder.where('Id', 1).first())!;
    const capture = captureStatements();
    await order.Items.populate(function () {
      this.where('Sku', 'A');
    });
    capture.restore();

    expect(capture.statements[0].expression).to.eq(AND_ONLY_LAZY);
  });
});
