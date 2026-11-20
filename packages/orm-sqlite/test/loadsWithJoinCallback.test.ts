import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import type { ISelectQueryBuilder, IWhereBuilder } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import './migrations/TestMigration_2022_02_08_01_13_00.js';
import { bootUow, captureStatements, registerUowConnection, UowClient, UowOrder, UowOrderTag, UowTag } from './uowFixture.js';

function select(query: unknown): SelectQueryBuilder {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  return query;
}

function statementCounts(query: unknown): { columns: number; joins: number } {
  const builder = select(query);
  return { columns: builder.getColumns().length, joins: builder.JoinStatements.length };
}

const calls = { where: 0, query: 0 };

function whereAcme(this: IWhereBuilder<UowClient>): void {
  calls.where++;
  this.where('Name', 'acme');
}

function selectClientName(this: ISelectQueryBuilder<UowClient>): void {
  calls.query++;
  this.select('Name', 'ClientName');
}

function joinClient(this: ISelectQueryBuilder<UowOrder>): void {
  this.leftJoin<UowClient>(UowClient, whereAcme, selectClientName);
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('relation loads whose populate callback joins with a callback', function () {
  this.timeout(30000);

  before(() => {
    registerUowConnection();
  });

  beforeEach(async () => {
    await bootUow();
    await UowClient.insert({ Name: 'acme' });
    await UowClient.insert({ Name: 'beta' });
    await UowOrder.insert({ Total: 10, client_id: 1 });
    await UowOrder.insert({ Total: 20, client_id: 2 });
    await UowTag.insert({ Name: 'x' });
    await UowOrderTag.insert({ order_id: 1, tag_id: 1 });
    calls.where = 0;
    calls.query = 0;
  });

  afterEach(() => DI.clearCache());

  it('a hasMany load whose populate callback joins with a callback runs and carries the joined column', async () => {
    const [client] = await UowClient.where('Id', 1).populate('Orders', joinClient);

    expect([...client.Orders].map((o) => ({ Id: o.Id, Total: o.Total, ClientName: Reflect.get(o, 'ClientName') as unknown }))).to.deep.equal([{ Id: 1, Total: 10, ClientName: 'acme' }]);
  });

  it('the joined column is selected once in that load', async () => {
    const capture = captureStatements();
    try {
      await UowClient.where('Id', 1).populate('Orders', joinClient);
    } finally {
      capture.restore();
    }

    const load = capture.statements[1].expression;
    expect(load).to.contain('FROM `uow_order`');
    expect(occurrences(load, 'as `ClientName`')).to.equal(1);
    expect(occurrences(load, 'LEFT JOIN')).to.equal(1);
  });

  it("a join that selects a column named like one of the relation's own does not make the load ambiguous", async () => {
    const [client] = await UowClient.where('Id', 1).populate('Orders', function () {
      this.leftJoin<UowClient>(UowClient, whereAcme, function () {
        this.select('Id', 'ClientId');
      });
    });

    expect([...client.Orders].map((o) => ({ Id: o.Id, ClientId: Reflect.get(o, 'ClientId') as unknown }))).to.deep.equal([{ Id: 1, ClientId: 1 }]);
  });

  it('the join callbacks of a populate callback run once, whatever the number of loads', async () => {
    const capture = captureStatements();
    const totals: number[][] = [];
    try {
      for await (const client of UowClient.query().order('Id').populate('Orders', joinClient).stream({ batchSize: 1 })) {
        totals.push([...client.Orders].map((o) => o.Total));
      }
    } finally {
      capture.restore();
    }

    expect(totals).to.deep.equal([[10], [20]]);
    expect(capture.statements.filter((s) => s.expression.includes('FROM `uow_order`'))).to.have.length(2);
    expect(calls).to.deep.equal({ where: 1, query: 1 });
  });

  it("a load leaves the populate callback's builder as it was", async () => {
    let orders: unknown;
    let ordersAfterCallback = { columns: 0, joins: 0 };
    const keepOrders = (builder: unknown): void => {
      orders = builder;
      ordersAfterCallback = statementCounts(builder);
    };
    let tags: unknown;
    let tagsAfterCallback = { columns: 0, joins: 0 };
    const keepTags = (builder: unknown): void => {
      tags = builder;
      tagsAfterCallback = statementCounts(builder);
    };

    await UowClient.where('Id', 1).populate('Orders', function () {
      this.leftJoin<UowClient>(UowClient, whereAcme, selectClientName);
      keepOrders(this);
    });
    await UowOrder.where('Id', 1).populate('Tags', function () {
      this.leftJoin<UowClient>({ joinModel: UowClient, joinTableForeignKey: 'Id', sourceTablePrimaryKey: 'Id', callback: whereAcme, queryCallback: selectClientName });
      keepTags(this);
    });

    expect(ordersAfterCallback.joins).to.equal(1);
    expect(statementCounts(orders)).to.deep.equal(ordersAfterCallback);
    expect(tagsAfterCallback.joins).to.equal(1);
    expect(statementCounts(tags)).to.deep.equal(tagsAfterCallback);
  });
});
