import { DI } from '@spinajs/di';
import { QueryMiddleware, SelectQueryBuilder } from '@spinajs/orm';
import type { BuilderExecution, QueryBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import { db } from './common.js';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { Category } from './models/Category.js';
import { bootUow, registerUowConnection, UowClient, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

function label(execution: BuilderExecution): string {
  if (execution.kind === 'own') return 'own';
  if (execution.kind === 'recursive') return `recursive (${execution.relation.Name})`;
  if (execution.into === 'join') return 'merged into join';
  return `merged into ${execution.into} (${execution.relation.Name})`;
}

function executionOf(query: unknown): string {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  return label(query.state().execution);
}

/** The execution of the builder that `configure` hands to its callback. */
function seenBy(configure: (probe: (this: unknown) => void) => unknown): string {
  let seen = 'the callback did not run';
  configure(function (this: unknown) {
    seen = executionOf(this);
  });
  return seen;
}

const executed: string[] = [];

class ExecutionRecorder extends QueryMiddleware {
  public afterQueryCreation(): void {}

  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof SelectQueryBuilder) executed.push(`${query.Model?.name ?? 'no model'}: ${label(query.state().execution)}`);
  }
}

describe('state().execution of relation and join builders', function () {
  this.timeout(30000);

  before(() => {
    registerUowConnection();
    DI.register(ExecutionRecorder).as(QueryMiddleware);
  });

  after(() => {
    DI.unregister(ExecutionRecorder);
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
  });

  afterEach(() => DI.clearCache());

  it('a model query runs on its own', () => {
    expect(executionOf(UowOrder.query())).to.equal('own');
  });

  it('a belongsTo relation query is merged into the query it was populated on', () => {
    expect(seenBy((probe) => UowOrderItem.query().populate('Order', probe))).to.equal('merged into parent (Order)');
  });

  it('a hasMany relation query runs on its own', () => {
    expect(seenBy((probe) => UowOrder.query().populate('Items', probe))).to.equal('own');
  });

  it('a many-to-many relation query is merged into its junction query', () => {
    expect(seenBy((probe) => UowOrder.query().populate('Tags', probe))).to.equal('merged into junction (Tags)');
  });

  it('a recursive relation query runs as a recursive query', () => {
    expect(seenBy((probe) => Category.query().populate('Children', probe))).to.equal('recursive (Children)');
  });

  it("a join callback's query is merged into the join", () => {
    expect(
      seenBy((probe) =>
        UowOrder.query().leftJoin<UowClient>(
          UowClient,
          function () {
            this.where('Name', 'acme');
          },
          probe,
        ),
      ),
    ).to.equal('merged into join');
  });

  it('a belongsTo under a hasMany, and one reached through a path, are merged into their parents', () => {
    expect(
      seenBy((probe) =>
        UowOrder.query().populate('Items', function () {
          this.populate('Order', probe);
        }),
      ),
    ).to.equal('merged into parent (Order)');
    expect(seenBy((probe) => UowOrderItem.query().populate('Order.Client', probe))).to.equal('merged into parent (Client)');
  });

  it('a clone of a relation query keeps its execution', () => {
    let seen = 'the callback did not run';
    void UowOrderItem.query().populate('Order', function () {
      seen = executionOf(this.clone());
    });
    expect(seen).to.equal('merged into parent (Order)');
  });

  it('no select that reaches the database is a merged one', async () => {
    executed.length = 0;
    await UowOrder.where('Id', 1).populate('Client').populate('Items').populate('Tags');
    await Category.where('Id', 1).populate('Children');

    expect(executed.filter((e) => e.includes('merged'))).to.deep.equal([]);
    expect([...executed].sort()).to.deep.equal(['Category: own', 'Category: recursive (Children)', 'UowOrder: own', 'UowOrderItem: own', 'UowTag: own']);
  });
});
