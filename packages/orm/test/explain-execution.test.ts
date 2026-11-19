import { useTestApp } from '@spinajs/testing';
import { Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';
import { expect } from 'chai';
import 'mocha';
import type { Builder } from '../src/builders.js';
import { adoptStatements, executedStatements, recordStatement, setStatementRecording, statementRecording } from '../src/explain/execution.js';
import type { ExecutedStatement } from '../src/explain/execution.js';
import { Orm } from '../src/orm.js';
import { FakeSqliteDriver, ormApp, slowQueryMiddleware } from './misc.js';
import '../src/bootstrap.js';
import '@spinajs/log';

/** One statement per row, each recorded on the builder the driver is handed. */
class ChunkingDriver extends FakeSqliteDriver {
  public readonly MaxInsertRows = 1;

  public execute(builder: Builder<unknown>): Promise<unknown> {
    recordStatement(builder, { sql: 'INSERT INTO users (Name) VALUES (?)', bindings: [], rawSql: false, durationMs: 1, driver: this });
    return Promise.resolve({ RowsAffected: 1, LastInsertId: 1 });
  }
}

const detached = new FakeSqliteDriver({ Driver: 'sqlite', Name: 'detached' });
const statement = (sql: string): ExecutedStatement => ({ sql, bindings: [], rawSql: false, durationMs: 1, driver: detached });

describe('executed-statement side channel', () => {
  useTestApp(() => ormApp({ register: (c) => c.register(ChunkingDriver).as('sqlite'), resolve: [Orm] }));

  afterEach(() => setStatementRecording(false));

  function connection(): ChunkingDriver {
    const driver = DI.get(Orm)?.Connections.get('sqlite');
    if (!(driver instanceof ChunkingDriver)) throw new Error('the sqlite connection is not the test driver');
    return driver;
  }

  it('records nothing until recording is switched on', () => {
    const builder = {};
    recordStatement(builder, statement('SELECT 1'));
    expect(statementRecording()).to.equal(false);
    expect(executedStatements(builder)).to.deep.equal([]);
  });

  it('keeps the statements of a builder in execution order', () => {
    setStatementRecording(true);
    const builder = {};
    recordStatement(builder, statement('SELECT 1'));
    recordStatement(builder, statement('SELECT 2'));
    expect(executedStatements(builder).map((s) => s.sql)).to.deep.equal(['SELECT 1', 'SELECT 2']);
  });

  it('moves the statements of a copy to the builder that owns it', () => {
    setStatementRecording(true);
    const owner = {};
    const copy = {};
    recordStatement(owner, statement('INSERT 1'));
    recordStatement(copy, statement('INSERT 2'));
    adoptStatements(owner, copy);
    expect(executedStatements(owner).map((s) => s.sql)).to.deep.equal(['INSERT 1', 'INSERT 2']);
    expect(executedStatements(copy)).to.deep.equal([]);
  });

  it('gives a chunked insert the statements of every chunk', async () => {
    // a query through the pipeline sets the switch from db.Explain.Enabled
    DI.get(Configuration)?.set('db.Explain', { Enabled: true });
    slowQueryMiddleware().reload();
    const insert = connection().insert().into('users').values([{ Name: 'ann' }, { Name: 'bob' }, { Name: 'cy' }]);
    await insert;
    expect(executedStatements(insert)).to.have.length(3);
  });
});
