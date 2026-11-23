import 'mocha';
import { expect } from 'chai';
import { tracer } from '@spinajs/tracing';
import { useInMemorySpans } from '@spinajs/tracing/testing';

import type { TraceSummary } from '../src/contracts/index.js';
import { MAX_TRACE_STREAMS } from '../src/controllers/Traces.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';
import { openSse } from './support/sse.js';
import type { SseClient } from './support/sse.js';

describe('GET /_studio/api/traces/stream', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;

  before(async () => {
    unregister = registerHeaderSource();
    app = await startApp();
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('emits one named trace event per finished root span', async () => {
    const stream = await openSse(app.port, '/_studio/api/traces/stream', 'bob');
    try {
      const first = tracer().startSpan('job nightly');
      first.end();
      const second = tracer().startSpan('job hourly');
      second.end();

      const a = await stream.next();
      const b = await stream.next();
      expect([a.event, b.event]).to.deep.eq(['trace', 'trace']);
      expect(a.id).to.eq(first.spanContext().traceId);
      expect((JSON.parse(a.data) as TraceSummary).traceId).to.eq(first.spanContext().traceId);
      expect((JSON.parse(b.data) as TraceSummary).rootName).to.eq('job hourly');
    } finally {
      stream.close();
    }
  });

  it("never streams Studio's own requests, in any letter case", async () => {
    const stream = await openSse(app.port, '/_STUDIO/API/TRACES/STREAM', 'bob');
    const spans = useInMemorySpans();
    try {
      await app.request().get('/_STUDIO/api/capabilities').set('x-user', 'bob');
      // Once the server span ended, its event (if any) was written before the marker's.
      await spans.waitFor('GET /_studio/api/capabilities', 10_000);
      tracer().startSpan('job marker').end();
      expect((JSON.parse((await stream.next()).data) as TraceSummary).rootName).to.eq('job marker');
    } finally {
      await spans.detach();
      stream.close();
    }
  });

  it('refuses a caller without studio:read', async () => {
    let refused: unknown;
    try {
      (await openSse(app.port, '/_studio/api/traces/stream', 'alice')).close();
    } catch (e) {
      refused = e;
    }
    // http cannot render the refusal as text/event-stream, the only type EventSource accepts.
    expect(refused).to.be.instanceOf(Error).and.to.have.property('message').that.matches(/406/);
    expect((await app.request().get('/_studio/api/traces/stream').set('Accept', 'application/json').set('x-user', 'alice')).status).to.eq(403);
  });

  // Last. A stream an earlier test closed is released when the server sees its socket close, which may still be
  // pending, so this counts the streams that opened instead of expecting exactly the cap.
  it(`answers 503 past ${MAX_TRACE_STREAMS} open streams`, async () => {
    const open: SseClient[] = [];
    let refused: unknown;
    try {
      while (refused === undefined && open.length <= MAX_TRACE_STREAMS) {
        try {
          open.push(await openSse(app.port, '/_studio/api/traces/stream', 'bob'));
        } catch (e) {
          refused = e;
        }
      }
      expect(open.length).to.be.within(1, MAX_TRACE_STREAMS);
      expect(refused).to.be.instanceOf(Error).and.to.have.property('message').that.matches(/503/);
    } finally {
      for (const stream of open) stream.close();
    }
  });
});
