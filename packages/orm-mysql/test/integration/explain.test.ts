import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext, redactPlan } from '@spinajs/orm';
import { asPlainObject } from '@spinajs/util';
import type { PlanNode } from '@spinajs/orm';
import { expect } from 'chai';
import 'mocha';
import * as net from 'node:net';
import '@spinajs/log';
import { MySqlOrmDriver } from '../../src/index.js';

const HOST = process.env.ORM_TEST_MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.ORM_TEST_MYSQL_PORT ?? 13306);
const USER = process.env.ORM_TEST_MYSQL_USER ?? 'root';
const PASSWORD = process.env.ORM_TEST_MYSQL_PASSWORD ?? 'root';
const DATABASE = process.env.ORM_TEST_MYSQL_DATABASE ?? 'test';

class ExplainConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'error', target: 'Empty' }] },
      db: {
        StrictTableCheck: false,
        Migration: { Startup: false },
        Connections: [{ Driver: 'orm-driver-mysql', Name: 'mysql', Host: HOST, Port: PORT, User: USER, Password: PASSWORD, Database: DATABASE, Migration: { OnStartup: false } }],
      },
    };
  }
}

function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** mysql2's `errno` of the error or of what it wraps (`inner`, `cause`). */
function errnos(err: unknown): number[] {
  const found: number[] = [];
  let current = asPlainObject(err);
  for (let depth = 0; current && depth < 6; depth++) {
    const errno = current['errno'];
    if (typeof errno === 'number') {
      found.push(errno);
    }
    current = asPlainObject(current['inner'] ?? current['cause']);
  }
  return found;
}

const flatten = (node: PlanNode): PlanNode[] => [node, ...node.children.flatMap(flatten)];

describe('mysql explain (integration)', function () {
  this.timeout(60000);

  function driver(): MySqlOrmDriver {
    const d = DI.get(Orm)?.Connections.get('mysql');
    if (!(d instanceof MySqlOrmDriver)) throw new Error('the mysql connection is not booted');
    return d;
  }

  before(async function () {
    if (!(await reachable())) {
      console.warn(`      MySQL at ${HOST}:${PORT} is unreachable, suite skipped`);
      this.skip();
    }

    DI.clearCache();
    DI.register(ExplainConf).as(Configuration);
    DI.register(MySqlOrmDriver).as('orm-driver-mysql');
    await DI.resolve(Orm);

    await driver().executeOnDb('DROP TABLE IF EXISTS explain_order, explain_user', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE explain_user (Id int PRIMARY KEY, Name varchar(64))', [], QueryContext.Schema);
    await driver().executeOnDb('CREATE TABLE explain_order (Id int PRIMARY KEY, UserId int, Total int, KEY explain_order_user (UserId))', [], QueryContext.Schema);
    await driver().executeOnDb("INSERT INTO explain_user (Id, Name) VALUES (1, 'ann')", [], QueryContext.Insert);
  });

  after(async () => {
    if (DI.get(Orm)) {
      await driver().executeOnDb('DROP TABLE IF EXISTS explain_order, explain_user', [], QueryContext.Schema);
      await driver().disconnect();
    }
    DI.clearCache();
    DI.unregister(ExplainConf);
  });

  it('plans a parameterised join', async () => {
    const plan = await driver().explain('SELECT u.Name, o.Total FROM explain_user u JOIN explain_order o ON o.UserId = u.Id WHERE u.Id = ?', [1]);

    const labels = flatten(plan.root).map((n) => n.label);
    expect(plan.dialect).to.equal('mysql');
    expect(plan.root.label).to.equal('select #1');
    expect(labels.some((l) => l.startsWith('u ('))).to.equal(true);
    expect(labels.some((l) => l.startsWith('o ('))).to.equal(true);
  });

  it('keeps an injection-shaped binding a value', async () => {
    await driver().explain('SELECT * FROM explain_user WHERE Name = ?', ["x'; DROP TABLE explain_user; --"]);

    const rows: unknown = await driver().executeOnDb('SELECT COUNT(*) AS n FROM explain_user', [], QueryContext.Select);
    expect(Number(asPlainObject(Array.isArray(rows) ? rows[0] : undefined)?.['n'])).to.equal(1);
  });

  it('names the subqueries of a select list and of ORDER BY the way the normaliser reads them', async () => {
    const plan = await driver().explain('SELECT (SELECT COUNT(*) FROM explain_order o WHERE o.UserId = u.Id) AS n FROM explain_user u ORDER BY (SELECT MAX(Total) FROM explain_order o2 WHERE o2.UserId = u.Id)', []);

    const selects = flatten(plan.root)
      .map((n) => n.label)
      .filter((l) => l.startsWith('select #'));
    expect(selects).to.have.length(3);
  });

  it('prints a bound value with a quote so that the redaction removes it', async () => {
    const plan = await driver().explain('SELECT * FROM explain_user WHERE Name = ?', ["O'Brien-secret"]);

    expect(JSON.stringify(plan)).to.contain('Brien-secret');
    expect(JSON.stringify(redactPlan(plan, false))).to.not.contain('Brien');
  });

  it('prints bound strings and numbers in where, and the redaction removes every one', async () => {
    const plan = await driver().explain('SELECT * FROM explain_user WHERE (Name = ? OR Name LIKE ?) AND Id <> ? AND Id < ?', ['sec-ret', 'pre-secret%', 31337, 4.25]);

    expect(JSON.stringify(plan)).to.contain('sec-ret').and.contain('31337');
    expect(JSON.stringify(redactPlan(plan, driver().ansiQuotedIdentifiers()))).to.not.match(/sec-ret|secret|31337|4\.25/);
  });

  it('runs on its own pool connection, not on the transaction in scope', async () => {
    await driver().transaction(async () => {
      await driver().executeOnDb('CREATE TEMPORARY TABLE tx_only (Id int)', [], QueryContext.Schema);

      const err: unknown = await driver()
        .explain('SELECT * FROM tx_only', [])
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      await driver().executeOnDb('DROP TEMPORARY TABLE tx_only', [], QueryContext.Schema);
      // ER_NO_SUCH_TABLE: the temporary table exists only in the transaction's session
      expect(errnos(err)).to.include(1146);
    });
  });
});
