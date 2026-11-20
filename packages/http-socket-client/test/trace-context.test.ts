import 'mocha';
import { expect } from 'chai';
import { propagation } from '@opentelemetry/api';
import type { TextMapPropagator } from '@opentelemetry/api';
import { DEFAULT_TRACING_OPTIONS, ensureTracing, withSpan } from '@spinajs/tracing';
import { resetTracing } from '@spinajs/tracing/testing';

import { closeAll } from './support/cleanup.js';
import { onlineDispatcher } from './support/commands.js';
import { makeConnection } from './support/connection.js';
import { serveStream } from './support/stream-stub.js';
import { streamsOn } from './support/streams.js';
import { StubServer } from './support/stub-server.js';

const THROWING_PROPAGATOR: TextMapPropagator = {
  inject: () => {
    throw new Error('propagator inject failed');
  },
  extract: (ctx) => ctx,
  fields: () => ['traceparent'],
};

describe('command trace context', () => {
  let server: StubServer;

  beforeEach(async () => {
    server = new StubServer();
    await server.start();
    server.handlers.set('ping', () => 'pong');
  });

  afterEach(async () => {
    closeAll();
    await server.stop();
    await resetTracing();
  });

  it('sends the active span as traceparent when the caller passes none', async () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'client-test' });
    const { commands } = await onlineDispatcher(server);
    const sc = await withSpan('caller', {}, async (span) => {
      await commands.execute('ping', null);
      return span.spanContext();
    });
    expect(server.requests[0].traceparent).to.match(new RegExp(`^00-${sc.traceId}-${sc.spanId}-0[01]$`));
  });

  it('keeps an explicit traceparent', async () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'client-test' });
    const { commands } = await onlineDispatcher(server);
    await withSpan('caller', {}, () => commands.execute('ping', null, { traceparent: '00-abc-def-01' }));
    expect(server.requests[0].traceparent).to.equal('00-abc-def-01');
  });

  it('sends commands and streams without a traceparent when the registered propagator throws', async () => {
    propagation.setGlobalPropagator(THROWING_PROPAGATOR);
    try {
      serveStream(server, 'n.list', () => [0]);
      const { connection, commands } = await onlineDispatcher(server);

      expect(await commands.execute('ping', null)).to.equal('pong');
      expect(await streamsOn(connection).stream<number>('n.list', null)[Symbol.asyncIterator]().next()).to.deep.equal({ value: 0, done: false });
      expect(server.requests.map((request) => request.traceparent)).to.deep.equal([undefined, undefined]);
    } finally {
      propagation.disable();
    }
  });

  it('sends no traceparent when no propagator is registered', async () => {
    const { commands } = await onlineDispatcher(server);
    await commands.execute('ping', null);
    expect(server.requests[0]).to.not.have.property('traceparent');
  });

  it('sends the context of the call that started a held stream, not of the connection event that transmits it', async () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'client-test' });
    serveStream(server, 'n.list', () => [0]);
    const connection = makeConnection(server);
    const items = streamsOn(connection).stream<number>('n.list', null, { whenOffline: 'wait' });

    let first: Promise<IteratorResult<number>> | undefined;
    const sc = await withSpan('caller', {}, (span) => {
      first = items[Symbol.asyncIterator]().next();
      return span.spanContext();
    });
    connection.connect();
    await first;

    expect(server.requests[0].traceparent).to.match(new RegExp(`^00-${sc.traceId}-${sc.spanId}-0[01]$`));
  });
});
