import { DI } from '@spinajs/di';
import type { ICompilerOutput } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { bootUow, captureStatements, registerUowConnection, UowClient, UowOrder, UowOrderItem } from './uowFixture.js';

function sql(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): string {
  const out = query.toDB();
  return String((Array.isArray(out) ? out[0] : out).expression);
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
    expect(rows[0].Order.Value?.Total).to.eq(10);
  });

  it('a nested belongsTo callback stays inside the group of its parent relation', async () => {
    const query = UowOrderItem.where('Sku', 'NOPE').populate('Order', function () {
      this.populate('Client', function () {
        this.where('Name', 'none').orWhere('Name', 'acme');
      });
    });

    expect(sql(query)).to.contain('WHERE `$UowOrderItem$`.`Sku` = ? AND ( ( `$Order$.$Client$`.`Name` = ? OR `$Order$.$Client$`.`Name` = ? ) )');
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

  it('a clone taken after compile qualifies a nested whereColumn() with the nested alias', () => {
    const query = UowOrderItem.where('Sku', 'A').populate('Order', function () {
      this.populate('Client', function () {
        this.whereColumn('Id', '=', 'Id');
      });
    });
    const where = (text: string) => text.slice(text.indexOf(' WHERE '));
    const compiled = sql(query);

    expect(where(compiled)).to.eq(' WHERE `$UowOrderItem$`.`Sku` = ? AND ( ( `$Order$.$Client$`.`Id` = `$Order$.$Client$`.`Id` ) )');
    // only the WHERE: on 3.x a clone taken after compile also rebinds the nested LEFT JOIN's source alias
    expect(where(sql(query.clone()))).to.eq(where(compiled));
  });
});
