import 'mocha';
import { expect } from 'chai';
import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import type { Class } from '@spinajs/di';
import '@spinajs/log';
import { Orm, redactPlan } from '@spinajs/orm';
import type { PlanNode } from '@spinajs/orm';
import { createTestApp, type TestApp } from '@spinajs/testing';

import { PgliteOrmDriver } from '../src/index.js';

const CONNECTION = 'pglite-explain';
const SILENT = { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] };
const flatten = (node: PlanNode): PlanNode[] => [node, ...node.children.flatMap(flatten)];

function configuration(): Class<Configuration> {
  return class PgliteExplainConfiguration extends FrameworkConfiguration {
    public async resolve(): Promise<void> {
      await super.resolve();
      this.set('logger', SILENT);
      this.set('db', { StrictTableCheck: false, Connections: [{ Driver: 'orm-driver-pglite', Name: CONNECTION }] });
    }
  };
}

describe('PgliteOrmDriver.explain (inherited from PostgresOrmDriver)', function () {
  this.timeout(30000);

  let app: TestApp;
  let driver: PgliteOrmDriver;

  beforeEach(async () => {
    app = await createTestApp({ configuration: configuration(), register: (c) => c.register(PgliteOrmDriver).as('orm-driver-pglite') });
    const connection = (await app.resolve(Orm)).Connections.get(CONNECTION);
    if (!(connection instanceof PgliteOrmDriver)) throw new Error('the pglite connection is not booted');
    driver = connection;
    await driver.schema().createTable('ex_users', (t) => {
      t.int('Id').primaryKey();
      t.string('Name');
    });
    await driver.schema().createTable('ex_orders', (t) => {
      t.int('Id').primaryKey();
      t.int('UserId');
    });
  });

  afterEach(() => app.dispose());

  it('normalises EXPLAIN (FORMAT JSON) of a join into a nested plan with bound parameters', async () => {
    const plan = await driver.explain('SELECT u."Name" FROM "ex_users" u JOIN "ex_orders" o ON o."UserId" = u."Id" WHERE u."Id" = ?', [1]);

    expect(plan.dialect).to.equal('postgres');
    expect(flatten(plan.root).some((n) => /Join|Nested Loop/.test(n.label))).to.equal(true);
  });

  it('prints bound values in conditions and keys, and the redaction removes them', async () => {
    const filtered = await driver.explain('SELECT * FROM "ex_users" WHERE "Name" = ? OR lower("Name") = ? ORDER BY "Id" + ?', ['sec-ret-1', 'fn-secret-2', 31337]);
    const grouped = await driver.explain('SELECT count(*) FROM "ex_users" GROUP BY "Id" * ?', [77777]);

    expect(JSON.stringify([filtered, grouped])).to.contain('sec-ret-1').and.contain('31337').and.contain('77777');
    const redacted = [filtered, grouped].map((plan) => redactPlan(plan, driver.ansiQuotedIdentifiers()));
    expect(JSON.stringify(redacted)).to.not.match(/sec-ret|secret|31337|77777/);
    expect(JSON.stringify(redacted)).to.contain('\\"Name\\"');
  });

  it('refuses a data-changing statement before reaching the database', async () => {
    const err: unknown = await driver.explain('DELETE FROM "ex_users"', []).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).to.be.instanceOf(Error);
    expect(String(err)).to.contain('only a single SELECT or WITH statement can be explained');
  });

  it('quotes identifiers with double quotes, so the sanitizer keeps them', () => {
    expect(driver.ansiQuotedIdentifiers()).to.equal(true);
  });
});
