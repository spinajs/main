import 'mocha';
import { expect } from 'chai';
import { SpanKind } from '@opentelemetry/api';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, QueryContext, QueryMiddleware, RawQuery, SlowQueryMiddleware, SlowQuerySink, setStatementRecording } from '@spinajs/orm';
import type { SlowQueryRecord } from '@spinajs/orm';
import { DEFAULT_TRACING_OPTIONS, ensureTracing, withSpan } from '@spinajs/tracing';
import { resetTracing } from '@spinajs/tracing/testing';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf } from './common.js';
import '@spinajs/log';

class CollectingSink extends SlowQuerySink {
  public static records: SlowQueryRecord[] = [];

  public record(entry: SlowQueryRecord): void {
    CollectingSink.records.push(entry);
  }
}

function sqlite(): SqliteOrmDriver {
  const driver = DI.get(Orm)?.Connections.get('sqlite');
  if (!(driver instanceof SqliteOrmDriver)) throw new Error('the sqlite connection is not booted');
  return driver;
}

function slowQueries(): SlowQueryMiddleware {
  const found = DI.resolve<QueryMiddleware>(Array.ofType(QueryMiddleware)).find((m): m is SlowQueryMiddleware => m instanceof SlowQueryMiddleware);
  if (!found) throw new Error('SlowQueryMiddleware is not registered');
  return found;
}

describe('orm-sqlite slow-query capture', () => {
  before(() => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'orm-sqlite-test' });
  });

  after(() => resetTracing());

  beforeEach(async () => {
    CollectingSink.records = [];
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    DI.register(CollectingSink).as(SlowQuerySink);
    for (const b of await DI.resolve<Bootstrapper>(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Orm);
    await sqlite().executeOnDb('CREATE TABLE explain_user (Id INTEGER PRIMARY KEY, Name TEXT)', [], QueryContext.Schema);
    await sqlite().executeOnDb("INSERT INTO explain_user (Id, Name) VALUES (1, 'ann')", [], QueryContext.Insert);
  });

  afterEach(async () => {
    setStatementRecording(false);
    await DI.get(Orm)?.dispose();
    DI.clearCache();
  });

  it('turns a forced slow select into a record carrying the server span trace id (id-only mode)', async () => {
    const configuration = DI.get(Configuration);
    if (!configuration) throw new Error('no Configuration is resolved');
    configuration.set('db.Explain', { Enabled: true, SlowQueryMs: 0, MaxPerMinute: 10, CaptureBindings: false });
    slowQueries().reload();

    let traceId = '';
    await withSpan('GET /users', { kind: SpanKind.SERVER }, async (server) => {
      traceId = server.spanContext().traceId;
      await sqlite().select().from('explain_user').where('Name', 'secret-binding-42');
    });
    await slowQueries().idle();

    expect(CollectingSink.records).to.have.length(1);
    const [record] = CollectingSink.records;
    expect(record.traceId).to.equal(traceId);
    expect(record.connection).to.equal('sqlite');
    expect(record).to.not.have.property('bindings');
    expect(JSON.stringify(record)).to.not.contain('secret-binding-42');
    expect(record).to.not.have.property('planError');
    expect(record.plan?.dialect).to.equal('sqlite');
    expect(record.plan?.raw).to.equal(null);
    expect(record.plan?.root.children.map((c) => c.label)).to.deep.equal(['SCAN explain_user']);
  });

  it('attempts a plan for a builder select whose quoted table name holds a #', async () => {
    DI.get(Configuration)?.set('db.Explain', { Enabled: true, SlowQueryMs: 0, MaxPerMinute: 10, CaptureBindings: false });
    slowQueries().reload();
    await sqlite().executeOnDb('CREATE TABLE `explain#tag` (Id INTEGER PRIMARY KEY)', [], QueryContext.Schema);

    await sqlite().select().from('explain#tag');
    await slowQueries().idle();

    expect(CollectingSink.records).to.have.length(1);
    expect(CollectingSink.records[0].sql).to.contain('explain#tag');
    expect(CollectingSink.records[0].planError).to.equal('driver orm-driver-sqlite cannot explain');
  });

  it('records a select with a raw condition the text check refuses without attempting a plan', async () => {
    DI.get(Configuration)?.set('db.Explain', { Enabled: true, SlowQueryMs: 0, MaxPerMinute: 10, CaptureBindings: false });
    slowQueries().reload();

    await sqlite().select().from('explain_user').where(RawQuery.create("Name <> '#'"));
    await slowQueries().idle();

    expect(CollectingSink.records).to.have.length(1);
    expect(CollectingSink.records[0]).to.not.have.property('plan');
    expect(CollectingSink.records[0]).to.not.have.property('planError');
  });
});
