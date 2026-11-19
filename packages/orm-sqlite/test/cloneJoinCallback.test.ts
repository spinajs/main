import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import type { ICompilerOutput } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { bootUow, registerUowConnection, UowClient, UowOrder, UowOrderItem, UowOrderTag, UowTag } from './uowFixture.js';

function select(query: unknown): SelectQueryBuilder {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  return query;
}

function compiled(query: { toDB(): ICompilerOutput | ICompilerOutput[] }): ICompilerOutput {
  const out = query.toDB();
  return Array.isArray(out) ? out[0] : out;
}

const calls = { where: 0, query: 0 };

function withClientJoin() {
  return UowOrder.query()
    .select('Id')
    .select('Total')
    .leftJoin<UowClient>(
    UowClient,
    function () {
      calls.where++;
      this.where('Name', 'acme');
    },
    function () {
      calls.query++;
      this.select('Name', 'ClientName');
    },
  );
}

function rowsOf(orders: UowOrder[]): unknown[] {
  return orders.map((o) => ({ Id: o.Id, Total: o.Total, ClientName: Reflect.get(o, 'ClientName') as unknown }));
}

describe('SelectQueryBuilder.clone() of a query with a join callback', function () {
  this.timeout(30000);

  before(() => {
    registerUowConnection();
  });

  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
    await UowOrderItem.insert({ Sku: 'A', Qty: 1, order_id: 1 });
    await UowTag.insert({ Name: 'x' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    calls.where = 0;
    calls.query = 0;
  });

  afterEach(() => DI.clearCache());

  it('a clone of a query with a join callback compiles the statement of its source', () => {
    const query = withClientJoin();
    const clone = compiled(query.clone());

    expect(clone).to.deep.equal(compiled(query));
  });

  it('a clone of a clone compiles it too', () => {
    const query = withClientJoin();
    const clone = compiled(query.clone().clone());

    expect(clone).to.deep.equal(compiled(query));
  });

  it('a clone taken after the source compiled compiles it too', () => {
    const query = withClientJoin();
    const source = compiled(query);

    expect(compiled(query.clone())).to.deep.equal(source);
  });

  it('cloning does not run the join callbacks again', () => {
    const query = withClientJoin();
    expect(calls).to.deep.equal({ where: 1, query: 1 });

    query.clone().clone();
    query.clone();
    expect(calls).to.deep.equal({ where: 1, query: 1 });
  });

  it('a clone of a query with a join callback runs', async () => {
    const fresh = rowsOf(await withClientJoin());
    expect(fresh).to.deep.equal([{ Id: 1, Total: 10, ClientName: 'acme' }]);

    expect(rowsOf(await withClientJoin().clone())).to.deep.equal(fresh);
  });

  it('cloning leaves the source and the builder a join was merged from as they were', () => {
    let inner: unknown;
    const keep = (builder: unknown): void => {
      inner = builder;
    };
    const query = select(
      UowOrderItem.query().populate('Order', function () {
        keep(this);
        this.leftJoin<UowClient>(
          UowClient,
          function () {
            this.where('Name', 'acme');
          },
          function () {
            this.select('Name', 'ClientName');
          },
        );
      }),
    );
    const relationQuery = select(inner);
    const sql = compiled(query);
    const statements = () => [query.getColumns(), query.JoinStatements, relationQuery.getColumns(), relationQuery.JoinStatements].map((list) => [...list]);
    const before = statements();

    compiled(query.clone());
    compiled(query.clone().clone());

    const after = statements();
    expect(after.map((list) => list.length)).to.deep.equal(before.map((list) => list.length));
    after.forEach((list, i) => expect(list).to.have.ordered.members(before[i]));
    expect(compiled(query)).to.deep.equal(sql);
  });

  it('cloning a query a join was merged into leaves the builder it came from as it was', () => {
    const source = select(withClientJoin());
    const target = select(UowOrder.query());
    target.mergeBuilder(source);
    const sql = compiled(target);
    const statements = () => [source.getColumns(), source.JoinStatements, target.getColumns(), target.JoinStatements].map((list) => [...list]);
    const before = statements();

    expect(compiled(target.clone())).to.deep.equal(sql);
    expect(compiled(target.clone().clone())).to.deep.equal(sql);

    const after = statements();
    expect(after.map((list) => list.length)).to.deep.equal(before.map((list) => list.length));
    after.forEach((list, i) => expect(list).to.have.ordered.members(before[i]));
    expect(compiled(target)).to.deep.equal(sql);
  });

  it('a where on the clone does not reach the source', () => {
    const query = withClientJoin();
    const source = compiled(query);

    const clone = query.clone().where('Total', 10);
    expect(compiled(clone).expression).to.contain('`Total` = ?');
    expect(compiled(query)).to.deep.equal(source);
  });

  it('a where on the source does not reach the clone', () => {
    const query = withClientJoin();
    const clone = query.clone();
    const before = compiled(clone);

    query.where('Total', 10);
    expect(compiled(query).expression).to.contain('`Total` = ?');
    expect(compiled(clone)).to.deep.equal(before);
  });
});
