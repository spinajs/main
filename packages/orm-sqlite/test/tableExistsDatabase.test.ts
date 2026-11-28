import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Orm, QueryContext } from '@spinajs/orm';
import { expect } from 'chai';
import _ from 'lodash';
import 'mocha';
import sinon from 'sinon';
import '@spinajs/log';
import { SqliteOrmDriver } from '../src/index.js';
import { ConnectionConf, db } from './common.js';

class AttachedConf extends ConnectionConf {
  public async resolve(): Promise<void> {
    await super.resolve();
    _.set(this.Config, 'db.Connections[0].Database', 's');
  }
}

const sqlite = () => db().Connections.get('sqlite') as SqliteOrmDriver;
const run = (stmt: string, params: unknown[] = []) => sqlite().executeOnDb(stmt, params, QueryContext.Schema);
const exists = (table: string, schema?: string) => sqlite().schema().tableExists(table, schema);
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The statements the driver ran during `fn`. */
async function statementsDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const driver = sqlite();
  const original = driver.executeOnDb.bind(driver);
  const seen: string[] = [];
  const stub = sinon.stub(driver, 'executeOnDb').callsFake((stmt: string, params: unknown[], context: QueryContext) => {
    seen.push(stmt);
    return original(stmt, params, context);
  });
  try {
    await fn();
  } finally {
    stub.restore();
  }
  return seen;
}

describe('sqlite tableExists of a table in an attached database', function () {
  this.timeout(60000);

  let sandbox: string;
  let files = 0;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'spinajs-table-exists-db-'));
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  async function boot(conf: typeof ConnectionConf) {
    DI.register(conf).as(Configuration);
    await DI.resolve(Orm);
    files += 1;
    await run('ATTACH DATABASE ? AS s', [join(sandbox, `s-${files}.sqlite`)]);
    await run('CREATE TABLE main.t_main (Id INTEGER PRIMARY KEY)');
    await run('CREATE TABLE s.t_s (Id INTEGER PRIMARY KEY)');
    await run('CREATE TABLE main.t_both (Id INTEGER PRIMARY KEY)');
    await run('CREATE TABLE s.t_both (Id INTEGER PRIMARY KEY)');
  }

  async function shutdown(conf: typeof ConnectionConf) {
    await run('DETACH DATABASE s');
    DI.unregister(Configuration, conf);
    DI.clearCache();
  }

  describe('asked for a schema', () => {
    beforeEach(() => boot(ConnectionConf));
    afterEach(() => shutdown(ConnectionConf));

    it('finds a table that only the attached schema holds', async () => {
      expect(await exists('t_s', 's')).to.equal(true);
    });

    it('does not find a table that only main holds', async () => {
      expect(await exists('t_main', 's')).to.equal(false);
    });

    it('finds a table that main and the schema both hold', async () => {
      expect(await exists('t_both', 's')).to.equal(true);
    });

    it('reads sqlite_master of that schema after checking it is attached', async () => {
      expect(await statementsDuring(() => exists('t_s', 's'))).to.deep.equal(['SELECT 1 FROM pragma_database_list WHERE name = ? COLLATE NOCASE', "SELECT name FROM `s`.sqlite_master WHERE type='table' AND name=? LIMIT 1;"]);
    });

    it('reads main when main is named', async () => {
      expect(await exists('t_main', 'main')).to.equal(true);
      expect(await exists('t_s', 'main')).to.equal(false);
    });

    it('reads temp when temp is named', async () => {
      expect(await exists('t_tmp', 'temp')).to.equal(false);

      await run('CREATE TEMP TABLE t_tmp (Id INTEGER PRIMARY KEY)');

      expect(await exists('t_tmp', 'temp')).to.equal(true);
      expect(await exists('t_main', 'temp')).to.equal(false);
      expect(await exists('t_tmp', 's')).to.equal(false);
    });

    it('reads an attached schema named in another case', async () => {
      expect(await exists('t_s', 'S')).to.equal(true);
      expect(await exists('t_main', 'S')).to.equal(false);
    });

    it('reads a schema that is not attached as holding no table', async () => {
      expect(await exists('t_main', 'nope')).to.equal(false);
      expect(await exists('t_s', 'nope')).to.equal(false);
    });

    it('quotes a schema name and binds a table name that hold quotes, a backtick, a dot and a space', async () => {
      const schema = `s "q'\`. x`;
      const table = `t "q'\`. DROP TABLE t_main; --`;
      files += 1;
      await run(`ATTACH DATABASE ? AS ${quote(schema)}`, [join(sandbox, `s-${files}.sqlite`)]);
      try {
        await run(`CREATE TABLE ${quote(schema)}.${quote(table)} (Id INTEGER PRIMARY KEY)`);

        expect(await exists(table, schema)).to.equal(true);
        expect(await exists('t_s', schema)).to.equal(false);
        expect(await exists(table, 's')).to.equal(false);
        expect(await exists('t_main', 'main')).to.equal(true);
      } finally {
        await run(`DETACH DATABASE ${quote(schema)}`);
      }
    });
  });

  // No schema keeps the unqualified lookup, even on a connection with a Database: unqualified DDL lands in main.
  describe('asked for no schema, on a connection with Database s', () => {
    beforeEach(() => boot(AttachedConf));
    afterEach(() => shutdown(AttachedConf));

    it('reads unqualified sqlite_master with no attached check', async () => {
      expect(await statementsDuring(() => exists('t_main'))).to.deep.equal(["SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;"]);
    });

    it('finds a table that main holds', async () => {
      expect(await exists('t_main')).to.equal(true);
      expect(await exists('t_both')).to.equal(true);
    });

    it('does not find a table that only the attached schema holds', async () => {
      expect(await exists('t_s')).to.equal(false);
    });
  });
});
