import { DI } from '@spinajs/di';
import { QueryMiddleware, SelectQueryBuilder, SelectQueryExtension, defineQueryExtension } from '@spinajs/orm';
import type { QueryBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { db } from './common.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { Category } from './models/Category.js';
import { bootUow, registerUowConnection, UowClient, UowOrder, UowOrderItem } from './uowFixture.js';

// What the docs tell an extension to do: state in a WeakMap keyed by the builder, carried by onClone.
const labels = new WeakMap<object, string>();

const LabelKeeper = defineQueryExtension({
  name: 'test.label-keeper',
  target: 'select',
  methods: {},
  onClone(source, clone) {
    const label = labels.get(source);
    if (label !== undefined) labels.set(clone, label);
  },
});

const seen: string[] = [];

class LabelRecorder extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof SelectQueryBuilder) seen.push(`${query.Model?.name ?? 'no model'}: ${labels.get(query) ?? 'none'}`);
  }
}

describe('extension state on the statements the ORM runs itself', function () {
  this.timeout(30000);

  before(() => {
    registerUowConnection();
    DI.register(LabelKeeper).as(SelectQueryExtension);
    DI.register(LabelRecorder).as(QueryMiddleware);
  });

  after(() => {
    DI.unregister(LabelRecorder);
    DI.unregister(LabelKeeper);
  });

  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowOrderItem.insert({ Sku: 'B', Qty: 1, order_id: 1 });
    const driver = db().Connections.get('sqlite');
    if (!driver) throw new Error('no sqlite connection');
    await driver.insert().into('category').values([
      { Name: 'A', parent_id: null },
      { Name: 'A1', parent_id: 1 },
    ]);
    seen.length = 0;
  });

  afterEach(() => DI.clearCache());

  it('reaches the select of a hasMany populate', async () => {
    await UowOrder.where('Id', 1).populate('Items', function () {
      labels.set(this, 'items');
    });

    expect(seen).to.include('UowOrderItem: items');
  });

  it('reaches the select of a recursive populate', async () => {
    await Category.where('Id', 1).populate('Children', function () {
      labels.set(this, 'children');
    });

    expect(seen).to.include('Category: children');
  });

  it('reaches every page of a keyset stream', async () => {
    const query = UowOrderItem.query().order('Id');
    labels.set(query, 'stream');
    const skus: string[] = [];
    for await (const item of query.stream({ batchSize: 1 })) skus.push(item.Sku);

    expect(skus).to.deep.equal(['A', 'B']);
    expect(seen.length).to.be.greaterThan(1);
    expect([...new Set(seen)]).to.deep.equal(['UowOrderItem: stream']);
  });
});
