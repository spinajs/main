import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { SelectQueryExtension, defineQueryExtension } from '@spinajs/orm';
import type { BuilderExecution, QueryBuilder } from '@spinajs/orm';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { db } from './common.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { Category } from './models/Category.js';
import { bootUow, registerUowConnection, UowClient, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

function label(execution: BuilderExecution): string {
  if (execution.kind === 'own') return 'own';
  if (execution.kind === 'recursive') return `recursive (${execution.relation.Name})`;
  if (execution.into === 'join') return 'merged into join';
  return `merged into ${execution.into} (${execution.relation.Name})`;
}

const modelOf = (query: QueryBuilder): string => query.Model?.name ?? 'no model';

const merges: string[] = [];
let refuse = false;

const MergeRecorder = defineQueryExtension({
  name: 'test.merge-recorder',
  target: 'select',
  methods: {},
  onMerge(source, target) {
    if (refuse) throw new InvalidOperation('merge refused');
    merges.push(`${modelOf(source)} -> ${modelOf(target)}: ${label(source.state().execution)}`);
  },
});

describe('QueryExtension.onMerge', function () {
  this.timeout(30000);

  before(() => {
    registerUowConnection();
    DI.register(MergeRecorder).as(SelectQueryExtension);
  });

  after(() => {
    DI.unregister(MergeRecorder);
  });

  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowTag.insert({ Name: 'x' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    const driver = db().Connections.get('sqlite');
    if (!driver) throw new Error('no sqlite connection');
    await driver.insert().into('category').values([
      { Name: 'A', parent_id: null },
      { Name: 'A1', parent_id: 1 },
    ]);
    merges.length = 0;
    refuse = false;
  });

  afterEach(() => DI.clearCache());

  it('a belongsTo populate is merged when the query runs, not when it is built', async () => {
    const query = UowOrderItem.where('Id', 1).populate('Order');
    expect(merges).to.deep.equal([]);

    await query;
    expect(merges).to.deep.equal(['UowOrder -> UowOrderItem: merged into parent (Order)']);
  });

  it('compiling the same query twice merges once', () => {
    const query = UowOrderItem.where('Id', 1).populate('Order');
    query.toDB();
    query.toDB();
    expect(merges).to.have.length(1);
  });

  it('a many-to-many populate is merged into its junction query', async () => {
    await UowOrder.where('Id', 1).populate('Tags');
    expect(merges).to.deep.equal(['UowTag -> UowTag: merged into junction (Tags)']);
  });

  it('a hasMany and a recursive populate merge nothing', async () => {
    await UowOrder.where('Id', 1).populate('Items');
    await Category.where('Id', 1).populate('Children');
    expect(merges).to.deep.equal([]);
  });

  it('a join callback is merged at the join() call', () => {
    void UowOrder.query().leftJoin<UowClient>(UowClient, function () {
      this.where('Name', 'acme');
    });
    expect(merges).to.deep.equal(['UowClient -> UowOrder: merged into join']);
  });

  it('count() merges a belongsTo populate at the call', () => {
    void UowOrderItem.query().populate('Order').count();
    expect(merges).to.deep.equal(['UowOrder -> UowOrderItem: merged into parent (Order)']);
  });

  it('a keyset stream merges once, before its first page runs', async () => {
    const skus: string[] = [];
    for await (const item of UowOrderItem.query().order('Id').populate('Order').stream({ batchSize: 1 })) skus.push(item.Sku);

    expect(skus).to.deep.equal(['A']);
    expect(merges).to.deep.equal(['UowOrder -> UowOrderItem: merged into parent (Order)']);
  });

  it('a hook that throws rejects the query', async () => {
    refuse = true;
    await expect(Promise.resolve(UowOrderItem.where('Id', 1).populate('Order'))).to.be.rejectedWith(InvalidOperation, 'merge refused');
  });

  it('reads the same rows with the hook installed', async () => {
    const [item] = await UowOrderItem.where('Id', 1).populate('Order');
    expect(item.Order.Value.Total).to.equal(10);
  });
});
