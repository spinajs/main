import 'mocha';
import { expect } from 'chai';
import { QueryContext } from '@spinajs/orm';
import type { PlanNode } from '@spinajs/orm';
import type { PostgresOrmDriver } from '../../src/index.js';
import { bootPostgres, requirePostgres } from './support.js';
import type { PgTestDb } from './support.js';
import { sqlState } from './harness.js';

const flatten = (node: PlanNode): PlanNode[] => [node, ...node.children.flatMap(flatten)];

describe('postgres explain (integration)', function () {
  this.timeout(60000);

  let pgdb: PgTestDb | undefined;

  function driver(): PostgresOrmDriver {
    if (!pgdb) throw new Error('the postgres test database is not booted');
    return pgdb.driver;
  }

  before(async function () {
    await requirePostgres(this);
    pgdb = await bootPostgres('explain');
    await driver().executeOnDb('CREATE TABLE explain_user ("Id" integer PRIMARY KEY, "Name" text)', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE explain_order ("Id" integer PRIMARY KEY, "UserId" integer, "Total" integer)', [], QueryContext.Schema);
    await driver().executeOnDb('INSERT INTO explain_user ("Id", "Name") VALUES (1, \'ann\')', [], QueryContext.Insert);
  });

  after(async () => {
    await pgdb?.dispose();
  });

  it('plans a parameterised join', async () => {
    const plan = await driver().explain('SELECT u."Name", o."Total" FROM explain_user u JOIN explain_order o ON o."UserId" = u."Id" WHERE u."Id" = ?', [1]);

    const labels = flatten(plan.root).map((n) => n.label);
    expect(plan.dialect).to.equal('postgres');
    expect(plan.root.estimatedCost).to.be.a('number');
    expect(labels.some((l) => / on explain_user\b/.test(l))).to.equal(true);
    expect(labels.some((l) => / on explain_order\b/.test(l))).to.equal(true);
  });

  it('keeps an injection-shaped binding a value', async () => {
    await driver().explain('SELECT * FROM explain_user WHERE "Name" = ?', ["x'; DROP TABLE explain_user; --"]);

    const rows: unknown = await driver().executeOnDb('SELECT count(*)::int AS n FROM explain_user', [], QueryContext.Select);
    expect(rows).to.deep.equal([{ n: 1 }]);
  });

  it('runs on its own pool connection, not on the transaction in scope', async () => {
    await driver().transaction(async () => {
      await driver().executeOnDb('CREATE TEMPORARY TABLE tx_only ("Id" integer) ON COMMIT DROP', [], QueryContext.Schema);

      const err: unknown = await driver()
        .explain('SELECT * FROM tx_only', [])
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      // the temporary table exists only in the transaction's session
      expect(sqlState(err)).to.equal('42P01');
    });
  });
});
