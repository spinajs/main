import 'mocha';
import { expect } from 'chai';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { DI } from '@spinajs/di';
import { Builder, executedStatements, fingerprint, QueryBuilder, QueryContext, setStatementRecording } from '@spinajs/orm';
import type { IColumnDescriptor, ICompilerOutput, ISupportedFeature, ITransactionContext, OrmDriver } from '@spinajs/orm';
import { withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';
import { SqlDriver } from '../src/index.js';

class StatementFailed extends Error {}

class EchoDriver extends SqlDriver {
  public failWith: Error | undefined;

  public executeOnDb(): Promise<unknown> {
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve([{ Id: 1 }, { Id: 2 }]);
  }
  public ping(): Promise<boolean> {
    return Promise.resolve(true);
  }
  public connect(): Promise<OrmDriver> {
    return Promise.resolve(this);
  }
  public disconnect(): Promise<OrmDriver> {
    return Promise.resolve(this);
  }
  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: false };
  }
  public tableInfo(): Promise<IColumnDescriptor[]> {
    return Promise.resolve([]);
  }
  protected _begin(): Promise<ITransactionContext> {
    return Promise.resolve({ depth: 0 });
  }
  protected _commit(): Promise<void> {
    return Promise.resolve();
  }
  protected _rollback(): Promise<void> {
    return Promise.resolve();
  }
  protected _savepoint(): Promise<void> {
    return Promise.resolve();
  }
  protected _releaseSavepoint(): Promise<void> {
    return Promise.resolve();
  }
  protected _rollbackToSavepoint(): Promise<void> {
    return Promise.resolve();
  }
  protected _dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class StreamingDriver extends EchoDriver {
  public failAfter: number | undefined;

  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: false, streaming: true };
  }

  public async *executeStreamOnDb(): AsyncGenerator<unknown> {
    for (let id = 1; id <= 3; id++) {
      if (this.failAfter !== undefined && id > this.failAfter) throw new StatementFailed('cursor lost, params: secret-binding-42');
      yield { Id: id };
    }
  }
}

/** A cursor that yields rows and cannot be closed. */
class BrokenCursorDriver extends EchoDriver {
  public supportedFeatures(): ISupportedFeature {
    return { events: false, insertReturning: false, streaming: true };
  }

  public executeStreamOnDb(): AsyncIterable<unknown> {
    const cursor: AsyncIterator<unknown> = {
      next: () => Promise.resolve({ done: false, value: { Id: 1 } }),
      return: () => Promise.reject(new StatementFailed('cursor close failed')),
    };
    return { [Symbol.asyncIterator]: () => cursor };
  }
}

/** A real `QueryBuilder`, so the driver reads its table the way it reads any builder's. */
class StubQuery extends QueryBuilder<unknown> {
  constructor(
    driver: OrmDriver,
    private readonly compiled: ICompilerOutput | ICompilerOutput[],
    context: QueryContext = QueryContext.Select,
  ) {
    super(DI.RootContainer, driver);
    this.QueryContext = context;
    this.setTable('users');
  }

  public toDB(): ICompilerOutput | ICompilerOutput[] {
    return this.compiled;
  }
}

/** A `Builder` that is not a `QueryBuilder`, like `executeSql`'s fragment: it has no table. */
class StubFragment extends Builder<unknown> {
  constructor(
    driver: OrmDriver,
    private readonly sql: string,
  ) {
    super(DI.RootContainer, driver);
    this.QueryContext = QueryContext.Select;
  }

  public toDB(): ICompilerOutput {
    return { expression: this.sql, bindings: [] };
  }
}

const OPTIONS = { Driver: 'orm-driver-sqlite', Name: 'main' };
const query = (driver: OrmDriver, expression: string, bindings: unknown[] = [], context?: QueryContext): StubQuery => new StubQuery(driver, { expression, bindings }, context);

describe('SqlDriver db.query spans', () => {
  let memory: InMemorySpans;

  beforeEach(() => {
    memory = useInMemorySpans();
  });

  afterEach(async () => {
    setStatementRecording(false);
    await memory.detach();
  });

  after(() => resetTracing());

  it('emits one CLIENT db.query span parented to the active span', async () => {
    const d = new EchoDriver(OPTIONS);
    let parentSpanId = '';
    await withSpan('parent', {}, async (parent) => {
      parentSpanId = parent.spanContext().spanId;
      await d.execute(query(d, 'SELECT * FROM `users` WHERE `Name` = ?', ['ann']));
    });

    const spans = memory.byName('db.query');
    expect(spans).to.have.length(1);
    expect(spans[0].kind).to.equal(SpanKind.CLIENT);
    expect(spans[0].parentSpanContext?.spanId).to.equal(parentSpanId);
  });

  it('describes the statement with OTel and spina attributes', async () => {
    const d = new EchoDriver(OPTIONS);
    const sql = "SELECT * FROM `users` WHERE `Name` = ? AND `Kind` = 'admin'";
    await d.execute(query(d, sql, ['ann']));

    const [span] = memory.byName('db.query');
    expect(span.attributes).to.deep.include({
      'db.system.name': 'sqlite',
      'db.operation.name': 'SELECT',
      'db.collection.name': 'users',
      'db.query.text': 'SELECT * FROM `users` WHERE `Name` = ? AND `Kind` = ?',
      'spina.db.fingerprint': fingerprint(sql),
      'spina.db.connection': 'main',
      'db.response.returned_rows': 2,
    });
  });

  it('never puts bindings into attributes', async () => {
    const d = new EchoDriver(OPTIONS);
    await d.execute(query(d, 'SELECT * FROM `users` WHERE `Password` = ?', ['secret-binding-42']));

    const [span] = memory.byName('db.query');
    expect(JSON.stringify(span.attributes)).to.not.contain('secret-binding-42');
  });

  it('reads a double-quoted token as a string on a connection that quotes with backticks', async () => {
    const d = new EchoDriver(OPTIONS);
    await d.execute(query(d, 'SELECT * FROM `users` WHERE `Password` = "secret-binding-42"'));

    expect(memory.byName('db.query')[0].attributes['db.query.text']).to.equal('SELECT * FROM `users` WHERE `Password` = ?');
  });

  it('keeps a backslash-escaped literal out of the query text', async () => {
    const d = new EchoDriver(OPTIONS);
    await d.execute(query(d, "SELECT * FROM `users` WHERE `Name` = 'O\\'Brien-secret-binding-42' AND `Kind` = 'x'"));

    const [span] = memory.byName('db.query');
    expect(span.attributes['db.query.text']).to.equal('SELECT * FROM `users` WHERE `Name` = ?');
    expect(JSON.stringify(span.attributes)).to.not.contain('secret-binding-42');
  });

  it('takes the operation from the statement, and from the builder only for WITH', async () => {
    const d = new EchoDriver(OPTIONS);
    await d.execute(query(d, 'INSERT INTO `users` (`Name`) VALUES (?)', ['ann'], QueryContext.Select));
    await d.execute(query(d, 'WITH x AS (SELECT 1) SELECT * FROM x', [], QueryContext.Select));

    expect(memory.byName('db.query').map((s) => s.attributes['db.operation.name'])).to.deep.equal(['INSERT', 'SELECT']);
  });

  it('names no table for a builder that has none', async () => {
    const d = new EchoDriver(OPTIONS);
    await d.execute(new StubFragment(d, 'SELECT COUNT(*) AS n FROM invoices'));

    expect(memory.byName('db.query')[0].attributes).to.not.have.property('db.collection.name');
  });

  it('marks a failed statement with its error type only', async () => {
    const d = new EchoDriver(OPTIONS);
    d.failWith = new StatementFailed('no such table, params: secret-binding-42');

    const failure: unknown = await d.execute(query(d, 'SELECT 1')).then(
      () => undefined,
      (e: unknown) => e,
    );

    const [span] = memory.byName('db.query');
    expect(failure).to.equal(d.failWith);
    expect(span.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'StatementFailed' });
    expect(span.attributes['error.type']).to.equal('StatementFailed');
    expect(JSON.stringify({ status: span.status, attributes: span.attributes, events: span.events })).to.not.contain('secret-binding-42');
  });

  it('emits one span per statement of a multi-statement builder', async () => {
    const d = new EchoDriver(OPTIONS);
    const statements = [
      { expression: 'CREATE TABLE a (x int)', bindings: [] },
      { expression: 'CREATE INDEX a_x ON a (x)', bindings: [] },
    ];
    await d.execute(new StubQuery(d, statements, QueryContext.Schema));

    expect(memory.byName('db.query').map((s) => s.attributes['db.operation.name'])).to.deep.equal(['CREATE', 'CREATE']);
  });

  it('records a statement with its driver, duration and span ids only while recording is on', async () => {
    const d = new EchoDriver(OPTIONS);
    const unrecorded = query(d, 'SELECT * FROM `users` WHERE `Id` = ?', [7]);
    await d.execute(unrecorded);
    expect(executedStatements(unrecorded)).to.deep.equal([]);

    setStatementRecording(true);
    memory.reset();
    const recorded = query(d, 'SELECT * FROM `users` WHERE `Id` = ?', [7]);
    await d.execute(recorded);

    const [span] = memory.byName('db.query');
    const [statement] = executedStatements(recorded);
    expect(statement.sql).to.equal('SELECT * FROM `users` WHERE `Id` = ?');
    expect(statement.bindings).to.deep.equal([7]);
    expect(statement.driver).to.equal(d);
    expect(statement.durationMs).to.be.at.least(0);
    expect(statement.traceId).to.equal(span.spanContext().traceId);
    expect(statement.spanId).to.equal(span.spanContext().spanId);
  });

  it('gives a builder that fails on one connection and runs on another two spans and one record', async () => {
    setStatementRecording(true);
    const replica = new EchoDriver({ Driver: 'orm-driver-sqlite', Name: 'replica' });
    replica.failWith = new StatementFailed('connection lost');
    const primary = new EchoDriver(OPTIONS);
    const select = query(primary, 'SELECT * FROM `users` WHERE `Id` = ?', [7]);

    await replica.execute(select).then(
      () => undefined,
      () => undefined,
    );
    await primary.execute(select);

    expect(memory.byName('db.query').map((s) => [s.attributes['spina.db.connection'], s.status.code])).to.deep.equal([
      ['replica', SpanStatusCode.ERROR],
      ['main', SpanStatusCode.UNSET],
    ]);
    expect(executedStatements(select).map((s) => s.driver)).to.deep.equal([primary]);
  });

  it('opens one span for a streamed statement and ends it when the stream ends', async () => {
    const d = new StreamingDriver(OPTIONS);
    const rows: unknown[] = [];
    let serverSpanId = '';
    await withSpan('GET /items', { kind: SpanKind.SERVER }, async (server) => {
      serverSpanId = server.spanContext().spanId;
      for await (const row of d.executeStream(query(d, 'SELECT * FROM `items`'), { batchSize: 10 })) rows.push(row);
    });

    const queries = memory.byName('db.query');
    expect(rows).to.have.length(3);
    expect(queries).to.have.length(1);
    expect(queries[0].parentSpanContext?.spanId).to.equal(serverSpanId);
    expect(queries[0].attributes).to.include({ 'db.query.text': 'SELECT * FROM `items`', 'db.response.returned_rows': 3 });
  });

  it('ends the span of a stream the consumer leaves early', async () => {
    const d = new StreamingDriver(OPTIONS);
    const stream = d.executeStream(query(d, 'SELECT * FROM `items`'), { batchSize: 10 });
    await stream.next();
    expect(memory.byName('db.query')).to.have.length(0);
    await stream.return(undefined);

    expect(memory.byName('db.query')[0].attributes['db.response.returned_rows']).to.equal(1);
  });

  it('marks a stream that fails part-way with the error type only', async () => {
    const d = new StreamingDriver(OPTIONS);
    d.failAfter = 1;
    const stream = d.executeStream(query(d, 'SELECT * FROM `items`'), { batchSize: 10 });
    await stream.next();
    const failure: unknown = await stream.next().then(
      () => undefined,
      (e: unknown) => e,
    );

    // the double has no logger, so what executeStream rethrows is not asserted; the span is marked before the log call
    const [span] = memory.byName('db.query');
    expect(failure).to.be.instanceOf(Error);
    expect(span.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'StatementFailed' });
    expect(span.attributes['db.response.returned_rows']).to.equal(1);
    expect(JSON.stringify({ status: span.status, attributes: span.attributes, events: span.events })).to.not.contain('secret-binding-42');
  });

  it('ends the span of a stream whose cursor fails to close, marked with the error type', async () => {
    const d = new BrokenCursorDriver(OPTIONS);
    const stream = d.executeStream(query(d, 'SELECT * FROM `items`'), { batchSize: 10 });
    await stream.next();
    const failure: unknown = await stream.return(undefined).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(failure).to.be.instanceOf(StatementFailed);
    expect(memory.byName('db.query')).to.have.length(1);
    const [span] = memory.byName('db.query');
    expect(span.attributes['db.response.returned_rows']).to.equal(1);
    expect(span.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'StatementFailed' });
    expect(span.attributes['error.type']).to.equal('StatementFailed');
  });
});
