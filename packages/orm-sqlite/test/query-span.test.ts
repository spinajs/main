import 'mocha';
import { expect } from 'chai';
import { SpanKind } from '@opentelemetry/api';
import { Bootstrapper, DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, QueryContext } from '@spinajs/orm';
import { withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';
import { SqliteOrmDriver } from './../src/index.js';
import { ConnectionConf } from './common.js';
import '@spinajs/log';

function sqlite(): SqliteOrmDriver {
  const driver = DI.get(Orm)?.Connections.get('sqlite');
  if (!(driver instanceof SqliteOrmDriver)) throw new Error('the sqlite connection is not booted');
  return driver;
}

describe('orm-sqlite db.query spans', () => {
  let memory: InMemorySpans;

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    DI.register(SqliteOrmDriver).as('orm-driver-sqlite');
    for (const b of await DI.resolve(Array.ofType(Bootstrapper))) {
      await b.bootstrap();
    }
    await DI.resolve(Orm);
    await sqlite().executeOnDb('CREATE TABLE span_user (Id INTEGER PRIMARY KEY, Name TEXT)', [], QueryContext.Schema);
    memory = useInMemorySpans();
  });

  afterEach(async () => {
    await memory.detach();
    await DI.get(Orm)?.dispose();
    DI.clearCache();
  });

  after(() => resetTracing());

  it('runs a builder select as one db.query child of the active span', async () => {
    let parentSpanId = '';
    await withSpan('GET /users', { kind: SpanKind.SERVER }, async (server) => {
      parentSpanId = server.spanContext().spanId;
      await sqlite().select().from('span_user').where('Name', 'secret-binding-42');
    });

    const spans = memory.byName('db.query');
    expect(spans).to.have.length(1);
    expect(spans[0].parentSpanContext?.spanId).to.equal(parentSpanId);
    expect(spans[0].attributes).to.include({ 'db.system.name': 'sqlite', 'db.collection.name': 'span_user', 'db.operation.name': 'SELECT', 'spina.db.connection': 'sqlite' });
    expect(JSON.stringify(spans[0].attributes)).to.not.contain('secret-binding-42');
  });

  it('labels a builder insert INSERT and a direct executeOnDb call with no span', async () => {
    await sqlite().insert().into('span_user').values({ Name: 'ann' });
    await sqlite().executeOnDb('SELECT COUNT(*) AS n FROM span_user', [], QueryContext.Select);

    expect(memory.byName('db.query').map((s) => s.attributes['db.operation.name'])).to.deep.equal(['INSERT']);
  });

  it('quotes identifiers with backticks, so a double-quoted token is a value', () => {
    expect(sqlite().ansiQuotedIdentifiers()).to.equal(false);
  });
});
