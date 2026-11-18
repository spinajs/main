import { useTestApp } from '@spinajs/testing';
import { Configuration } from '@spinajs/configuration-common';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import 'mocha';
import * as sinon from 'sinon';
import type { Log } from '@spinajs/log-common';
import { ManualClock } from '@spinajs/util';
import type { Builder } from '../src/builders.js';
import { Orm } from '../src/orm.js';
import { LogSlowQuerySink, MAX_PENDING_SLOW_QUERY_CAPTURES, recordStatement, setStatementRecording, SlowQuerySink, statementRecording } from '../src/explain/index.js';
import type { ExecutedStatement, ExplainOptions, QueryPlan, SlowQueryRecord } from '../src/explain/index.js';
import { FakeSqliteDriver, ormApp, slowQueryMiddleware as middleware } from './misc.js';
import '../src/bootstrap.js';
import '@spinajs/log';

const expect = chai.expect;

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';
const SELECT = 'SELECT * FROM users WHERE Id = ?';
const PLAN: QueryPlan = {
  dialect: 'sqlite',
  root: { label: 'QUERY PLAN', children: [{ label: 'SEARCH users', detail: "USING INDEX users_name (Name='ann')", children: [] }] },
  raw: [{ detail: "SEARCH users USING INDEX users_name (Name='ann')" }],
};
const REDACTED: QueryPlan = { dialect: 'sqlite', root: { label: 'QUERY PLAN', children: [{ label: 'SEARCH users', detail: 'USING INDEX users_name (Name=?)', children: [] }] }, raw: null };

/** Records the statement the test queued, the way SqlDriver.execute does: the fake compilers produce no SQL. */
class ExplainingDriver extends FakeSqliteDriver {
  public static next: Pick<ExecutedStatement, 'sql' | 'bindings' | 'durationMs' | 'rawSql'> = { sql: 'SELECT 1', bindings: [], durationMs: 0, rawSql: true };
  /** Set by a test to stand in for a read replica: the next statement is recorded as run there. */
  public static ranOn: ExplainingDriver | undefined;
  public explained: string[] = [];
  public explainedRawSql: Array<boolean | undefined> = [];

  public execute(builder: Builder<unknown>): Promise<unknown[]> {
    const ranOn = ExplainingDriver.ranOn ?? this;
    ExplainingDriver.ranOn = undefined;
    recordStatement(builder, { ...ExplainingDriver.next, driver: ranOn, traceId: TRACE_ID, spanId: SPAN_ID });
    return Promise.resolve([]);
  }

  public explain(sql: string, _bindings: unknown[], rawSql?: boolean): Promise<QueryPlan> {
    this.explained.push(sql);
    this.explainedRawSql.push(rawSql);
    return Promise.resolve(PLAN);
  }
}

class CollectingSink extends SlowQuerySink {
  public static records: SlowQueryRecord[] = [];

  public record(entry: SlowQueryRecord): void {
    CollectingSink.records.push(entry);
  }
}

/** The log sink with its logger readable, so a test can see the line it writes. */
class ReadableLogSink extends LogSlowQuerySink {
  public logger(): Log {
    return this.Log;
  }
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('SlowQueryMiddleware', () => {
  useTestApp(() =>
    ormApp({
      register: (c) => {
        c.register(ExplainingDriver).as('sqlite');
        c.register(CollectingSink).as(SlowQuerySink);
        c.register(ReadableLogSink).as(SlowQuerySink);
      },
      resolve: [Orm],
    }),
  );

  const records = () => CollectingSink.records;

  function logSink(): ReadableLogSink {
    const found = DI.resolve(Array.ofType(SlowQuerySink)).find((s): s is ReadableLogSink => s instanceof ReadableLogSink);
    if (!found) throw new Error('ReadableLogSink is not registered');
    return found;
  }

  function driver(): ExplainingDriver {
    const d = DI.get(Orm)?.Connections.get('sqlite');
    if (!(d instanceof ExplainingDriver)) throw new Error('the sqlite connection is not the test driver');
    return d;
  }

  function enable(overrides: Partial<ExplainOptions> = {}): void {
    const configuration = DI.get(Configuration);
    if (!configuration) throw new Error('no Configuration is resolved');
    configuration.set('db.Explain', { Enabled: true, SlowQueryMs: 200, MaxPerMinute: 10, CaptureBindings: false, ...overrides });
    middleware().reload();
  }

  async function run(sql = SELECT, durationMs = 300, rawSql = true): Promise<void> {
    ExplainingDriver.next = { sql, bindings: [7], durationMs, rawSql };
    await driver().select().from('users');
  }

  async function slowSelect(sql = SELECT, durationMs = 300, rawSql = true): Promise<void> {
    await run(sql, durationMs, rawSql);
    await middleware().idle();
  }

  beforeEach(() => {
    CollectingSink.records = [];
  });

  afterEach(() => {
    sinon.restore();
    setStatementRecording(false);
  });

  it('runs last in the pipeline', () => {
    expect(middleware().order).to.equal(2000);
  });

  it('records nothing and keeps no statement while db.Explain.Enabled is off', async () => {
    await slowSelect();
    expect(statementRecording()).to.equal(false);
    expect(records()).to.deep.equal([]);
  });

  it('records nothing below SlowQueryMs', async () => {
    enable();
    await slowSelect(undefined, 150);
    expect(records()).to.deep.equal([]);
  });

  it('records a slow select with a plan that carries no values, trace ids and no bindings', async () => {
    enable();
    await slowSelect("SELECT * FROM users WHERE Name = 'ann' AND Id = ?");

    expect(records()).to.have.length(1);
    const [record] = records();
    expect(record).to.include({ sql: 'SELECT * FROM users WHERE Name = ? AND Id = ?', driver: 'sqlite', connection: 'sqlite', durationMs: 300, traceId: TRACE_ID, spanId: SPAN_ID });
    expect(record.fingerprint).to.match(/^[0-9a-f]{16}$/);
    expect(record.at).to.be.instanceOf(Date);
    expect(record.plan).to.deep.equal(REDACTED);
    expect(record).to.not.have.property('bindings');
    expect(record).to.not.have.property('planError');
    expect(JSON.stringify(record)).to.not.contain('ann');
  });

  it('explains a builder-made select whose text the caller-written check would refuse', async () => {
    enable();
    await slowSelect('SELECT * FROM "price$list" WHERE "Tag" = ?', 300, false);

    expect(driver().explained).to.deep.equal(['SELECT * FROM "price$list" WHERE "Tag" = ?']);
    expect(driver().explainedRawSql).to.deep.equal([false]);
    expect(records()[0].plan).to.deep.equal(REDACTED);
  });

  it('never explains caller-written SQL the text check refuses', async () => {
    enable();
    await slowSelect('SELECT * FROM "price$list" WHERE "Tag" = ?', 300, true);

    expect(driver().explained).to.deep.equal([]);
    expect(records()).to.have.length(1);
    expect(records()[0]).to.not.have.property('plan');
    expect(records()[0]).to.not.have.property('planError');
  });

  it('tells the driver that a statement holds caller-written SQL', async () => {
    enable();
    await slowSelect();
    expect(driver().explainedRawSql).to.deep.equal([true]);
  });

  it('records a slow INSERT without a plan and without calling explain', async () => {
    enable();
    const insert = driver().insert().into('users');

    recordStatement(insert, { sql: 'INSERT INTO users (Name) VALUES (?)', bindings: ['ann'], rawSql: false, durationMs: 300, driver: driver() });
    middleware().afterQueryExecution(insert);
    await middleware().idle();

    expect(records()).to.have.length(1);
    expect(records()[0]).to.not.have.property('plan');
    expect(records()[0]).to.not.have.property('planError');
    expect(driver().explained).to.deep.equal([]);
  });

  it('records a builder that ran several statements once, with their summed duration', async () => {
    enable();
    const insert = driver().insert().into('users');

    recordStatement(insert, { sql: 'INSERT INTO users (Name) VALUES (?)', bindings: ['ann'], rawSql: false, durationMs: 150, driver: driver() });
    recordStatement(insert, { sql: 'INSERT INTO users (Name) VALUES (?)', bindings: ['bob'], rawSql: false, durationMs: 150, driver: driver() });
    middleware().afterQueryExecution(insert);
    await middleware().idle();

    expect(records().map((r) => r.durationMs)).to.deep.equal([300]);
    expect(records()[0].sql).to.equal('INSERT INTO users (Name) VALUES (?);\nINSERT INTO users (Name) VALUES (?)');
  });

  it('explains on the driver that ran the statement, not on the builder driver', async () => {
    enable();
    const replica = new ExplainingDriver({ Name: 'replica', Driver: 'sqlite' });
    ExplainingDriver.ranOn = replica;

    await slowSelect();

    expect(driver().explained).to.deep.equal([]);
    expect(replica.explained).to.deep.equal([SELECT]);
    expect(records()[0].connection).to.equal('replica');
  });

  it('explains a repeated slow query once per minute and still records every run', async () => {
    enable();

    await slowSelect();
    await slowSelect();

    expect(driver().explained).to.have.length(1);
    expect(records().map((r) => r.plan)).to.deep.equal([REDACTED, REDACTED]);
    expect(records()[1].fingerprint).to.equal(records()[0].fingerprint);
  });

  it('explains the same query again once the minute has passed', async () => {
    enable();
    const clock = new ManualClock(new Date(1_000));
    middleware().clock = clock;

    await slowSelect();
    clock.advance(59_999);
    await slowSelect();
    expect(driver().explained).to.have.length(1);

    clock.advance(1);
    await slowSelect();
    expect(driver().explained).to.have.length(2);
  });

  it('shares one explain call between captures of one fingerprint that overlap', async () => {
    enable();
    let release: (plan: QueryPlan) => void = () => undefined;
    const explain = sinon.stub(ExplainingDriver.prototype, 'explain').returns(new Promise<QueryPlan>((resolve) => (release = resolve)));

    await run();
    await run();
    await turn();
    await turn();
    release(PLAN);
    await middleware().idle();

    expect(explain.calledOnce).to.equal(true);
    expect(records().map((r) => r.plan)).to.deep.equal([REDACTED, REDACTED]);
  });

  it('drops slow statements past the pending limit and records the rest', async () => {
    enable();
    let release: (plan: QueryPlan) => void = () => undefined;
    sinon.stub(ExplainingDriver.prototype, 'explain').returns(new Promise<QueryPlan>((resolve) => (release = resolve)));

    for (let i = 0; i <= MAX_PENDING_SLOW_QUERY_CAPTURES; i++) await run();
    release(PLAN);
    await middleware().idle();

    expect(records()).to.have.length(MAX_PENDING_SLOW_QUERY_CAPTURES);
  });

  it('stops explaining past MaxPerMinute and says why', async () => {
    enable({ MaxPerMinute: 1 });

    await slowSelect('SELECT * FROM a');
    await slowSelect('SELECT * FROM b');

    expect(records()[0].plan).to.deep.equal(REDACTED);
    expect(records()[1]).to.not.have.property('plan');
    expect(records()[1].planError).to.equal('explain rate limit reached');
  });

  it('turns a failing explain into planError without throwing into the query', async () => {
    enable();
    sinon.stub(ExplainingDriver.prototype, 'explain').rejects(new TypeError('no such table: users, params: 7'));

    await slowSelect();

    expect(records()[0].planError).to.equal('TypeError');
    expect(records()[0]).to.not.have.property('plan');
  });

  it('keeps bindings, the explain error text and the plan as the driver gave it with CaptureBindings', async () => {
    enable({ CaptureBindings: true });
    await slowSelect();
    expect(records()[0].bindings).to.deep.equal([7]);
    expect(records()[0].plan).to.equal(PLAN);

    sinon.stub(ExplainingDriver.prototype, 'explain').rejects(new TypeError('no such table: users, params: 7'));
    await slowSelect('SELECT * FROM missing WHERE Id = ?');
    expect(records()[1].planError).to.equal('TypeError: no such table: users, params: 7');
  });

  it('records without a plan on a driver that cannot explain', async () => {
    enable();
    sinon.stub(ExplainingDriver.prototype, 'explain').value(undefined);

    await slowSelect();

    expect(records()[0]).to.not.have.property('plan');
    expect(records()[0].planError).to.equal('driver sqlite cannot explain');
  });

  it('never gives a record the plan of another connection', async () => {
    enable();
    const replica = new ExplainingDriver({ Name: 'replica', Driver: 'sqlite' });

    await slowSelect();
    ExplainingDriver.ranOn = replica;
    await slowSelect();

    expect(driver().explained).to.deep.equal([SELECT]);
    expect(replica.explained).to.deep.equal([SELECT]);
    expect(records().map((r) => r.connection)).to.deep.equal(['sqlite', 'replica']);
  });

  it('forgets remembered plans on reload, so a plan kept with values is not served once CaptureBindings is off', async () => {
    enable({ CaptureBindings: true });
    await slowSelect();
    expect(records()[0].plan).to.equal(PLAN);

    enable();
    await slowSelect();

    expect(records()[1].plan).to.deep.equal(REDACTED);
    expect(records()[1]).to.not.have.property('bindings');
    expect(driver().explained).to.have.length(2);
  });

  it('keeps a backslash-escaped literal out of the record, the plan and the log line', async () => {
    enable();
    const escaped: QueryPlan = {
      dialect: 'mysql',
      root: { label: 'select #1', children: [{ label: 'users (ALL)', detail: "where (`users`.`Name` = 'O\\'Brien-secret')", children: [] }] },
      raw: { attached_condition: "(`users`.`Name` = 'O\\'Brien-secret')" },
    };
    sinon.stub(ExplainingDriver.prototype, 'explain').resolves(escaped);
    const warn = sinon.stub(logSink().logger(), 'warn');

    await slowSelect();
    await slowSelect("SELECT * FROM users WHERE Name = 'O\\'Brien-secret' AND Id = ?");

    const [planned, unplanned] = records();
    expect(planned.plan?.root.children[0].detail).to.equal('where (`users`.`Name` = ?');
    expect(planned.plan?.raw).to.equal(null);
    expect(unplanned.sql).to.equal('SELECT * FROM users WHERE Name = ?');
    expect(unplanned).to.not.have.property('plan');
    expect(JSON.stringify(records())).to.not.contain('Brien');
    expect(warn.called).to.equal(true);
    expect(JSON.stringify(warn.args)).to.not.contain('Brien');
  });

  it('keeps exponent and hex literals out of the record and the plan', async () => {
    enable();
    const numeric: QueryPlan = { dialect: 'postgres', root: { label: 'Seq Scan', detail: '((Score > 1e-7) AND (Flags = 0xDEADBEEF))', children: [] }, raw: [] };
    sinon.stub(ExplainingDriver.prototype, 'explain').resolves(numeric);

    await slowSelect('SELECT * FROM users WHERE Score > 1.5e3 AND Total < 1e10 AND Flags = 0xDEADBEEF AND Id = ?');

    const [record] = records();
    expect(record.sql).to.equal('SELECT * FROM users WHERE Score > ? AND Total < ? AND Flags = ? AND Id = ?');
    expect(record.plan?.root.detail).to.equal('((Score > ?) AND (Flags = ?))');
    expect(JSON.stringify(record)).to.not.match(/DEADBEEF|e10|e3|e-7/);
  });

  it('keeps publishing to the other sinks when one throws', async () => {
    enable();
    sinon.stub(LogSlowQuerySink.prototype, 'record').throws(new Error('sink down'));

    await slowSelect();

    expect(records()).to.have.length(1);
  });
});
