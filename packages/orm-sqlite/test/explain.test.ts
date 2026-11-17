import 'mocha';
import { expect } from 'chai';
import * as sinon from 'sinon';
import { readFileSync } from 'node:fs';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { InvalidArgument } from '@spinajs/exceptions';
import { asRecord, Orm, QueryContext } from '@spinajs/orm';
import type { PlanNode, QueryPlan } from '@spinajs/orm';
import { normalizeSqlitePlan, SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf } from './common.js';
import '@spinajs/log';

const flatten = (node: PlanNode): PlanNode[] => [node, ...node.children.flatMap(flatten)];

function sqlite(): SqliteOrmDriver {
  const driver = DI.get(Orm)?.Connections.get('sqlite');
  if (!(driver instanceof SqliteOrmDriver)) throw new Error('the sqlite connection is not booted');
  return driver;
}

const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (err: unknown) => err,
  );

async function userCount(): Promise<number> {
  const rows: unknown = await sqlite().executeOnDb('SELECT COUNT(*) AS n FROM explain_user', [], QueryContext.Select);
  return Number(asRecord(Array.isArray(rows) ? rows[0] : undefined)?.['n']);
}

describe('orm-sqlite explain', () => {
  describe('normalizeSqlitePlan', () => {
    it('nests EXPLAIN QUERY PLAN rows under their parents (fixture snapshot)', () => {
      const rows: unknown = JSON.parse(readFileSync(new URL('./fixtures/explain-join-subquery.json', import.meta.url), 'utf8'));

      expect(normalizeSqlitePlan(rows)).to.deep.equal({
        dialect: 'sqlite',
        raw: rows,
        root: {
          label: 'QUERY PLAN',
          children: [
            { label: 'SEARCH u', detail: 'USING INTEGER PRIMARY KEY (rowid=?)', children: [] },
            { label: 'LIST SUBQUERY 1', children: [{ label: 'SCAN explain_order', children: [] }] },
            { label: 'SEARCH o', detail: 'USING INDEX explain_order_user (UserId=?)', children: [] },
          ],
        },
      });
    });

    it('attaches a row with an unknown parent to the root', () => {
      expect(normalizeSqlitePlan([{ id: 4, parent: 99, notused: 0, detail: 'SCAN t' }]).root.children).to.deep.equal([{ label: 'SCAN t', children: [] }]);
    });
  });

  describe('SqliteOrmDriver', () => {
    beforeEach(async () => {
      DI.clearCache();
      DI.register(ConnectionConf).as(Configuration);
      DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
      for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
        await b.bootstrap();
      }
      await DI.resolve(Orm);

      const d = sqlite();
      await d.executeOnDb('CREATE TABLE explain_user (Id INTEGER PRIMARY KEY, Name TEXT)', [], QueryContext.Schema);
      await d.executeOnDb('CREATE TABLE explain_order (Id INTEGER PRIMARY KEY, UserId INTEGER, Total INTEGER)', [], QueryContext.Schema);
      await d.executeOnDb('CREATE INDEX explain_order_user ON explain_order (UserId)', [], QueryContext.Schema);
      await d.executeOnDb("INSERT INTO explain_user (Id, Name) VALUES (1, 'ann')", [], QueryContext.Insert);
    });

    afterEach(async () => {
      sinon.restore();
      await DI.get(Orm)?.dispose();
      DI.clearCache();
    });

    it('plans a joined select with a subquery into a nested tree', async () => {
      const plan = await sqlite().explain('SELECT u.Name, o.Total FROM explain_user u JOIN explain_order o ON o.UserId = u.Id WHERE u.Id IN (SELECT UserId FROM explain_order WHERE Total > ?)', [10]);

      const nodes = flatten(plan.root);
      expect(plan.dialect).to.equal('sqlite');
      expect(plan.root.label).to.equal('QUERY PLAN');
      expect(nodes.some((n) => /^(SCAN|SEARCH) u$/.test(n.label))).to.equal(true);
      expect(nodes.some((n) => /^(SCAN|SEARCH) o$/.test(n.label))).to.equal(true);
      expect(nodes.some((n) => /SUBQUERY/.test(n.label) && n.children.length > 0)).to.equal(true);
    });

    it('refuses anything but a single read statement', async () => {
      expect(await rejection(sqlite().explain('DELETE FROM explain_user', []))).to.be.instanceOf(InvalidArgument);
      expect(await rejection(sqlite().explain('SELECT 1; DELETE FROM explain_user', []))).to.be.instanceOf(InvalidArgument);
      expect(await userCount()).to.equal(1);
    });

    it('binds an injection-shaped value instead of splicing it into the statement', async () => {
      await sqlite().explain('SELECT * FROM explain_user WHERE Name = ?', ["x'; DELETE FROM explain_user; --"]);
      expect(await userCount()).to.equal(1);
    });

    it('runs outside the transaction in scope and waits for it to end', async () => {
      const d = sqlite();
      const inTransaction: boolean[] = [];
      const original = d.executeOnDb.bind(d);
      sinon.stub(d, 'executeOnDb').callsFake((stmt: string, params: unknown[], ctx: QueryContext) => {
        if (stmt.startsWith('EXPLAIN')) {
          inTransaction.push(d.CurrentTransaction !== undefined);
        }
        return original(stmt, params, ctx);
      });

      let planned: Promise<QueryPlan> | undefined;
      let settledInside = false;
      await d.transaction(async () => {
        await d.executeOnDb("INSERT INTO explain_user (Id, Name) VALUES (2, 'bob')", [], QueryContext.Insert);
        planned = d.explain('SELECT * FROM explain_user', []);
        void planned.then(
          () => (settledInside = true),
          () => undefined,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settledInside).to.equal(false);
      });
      await planned;

      expect(inTransaction).to.deep.equal([false]);
    });
  });
});
