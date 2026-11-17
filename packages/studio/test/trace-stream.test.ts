import 'mocha';
import type { Server } from 'node:http';
import { expect } from 'chai';
import express from 'express';
import sinon from 'sinon';
import { ROOT_CONTEXT } from '@opentelemetry/api';

import { TraceStore } from '../src/buffers/trace-store.js';
import { MAX_TRACE_STREAMS, StudioTracesController, TRACE_STREAM_MAX_MS } from '../src/controllers/Traces.js';
import { StudioSpanProcessor } from '../src/processor.js';
import { fakeSpan, traceIdOf } from './support/spans.js';
import { openSse } from './support/sse.js';

class StreamHost extends StudioTracesController {
  public constructor(store: TraceStore) {
    super();
    this.Traces = store;
  }
}

describe('StudioTracesController.stream', () => {
  let store: TraceStore;
  let server: Server;
  let port = 0;
  let backlogged = false;
  let closed: Promise<void>[] = [];
  let clock: sinon.SinonFakeTimers;
  const finish = (trace: string, name: string) => {
    const span = fakeSpan({ trace, id: trace, name });
    const processor = new StudioSpanProcessor(() => store);
    processor.onStart(span, ROOT_CONTEXT);
    processor.onEnd(span);
  };

  beforeEach(async () => {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store = new TraceStore({ traces: 10, spansPerTrace: 10, maxBytes: 1_000_000, capture: { redact: new Set(), captureBindings: false }, basePath: '/_studio' });
    const host = new StreamHost(store);
    closed = [];
    server = express()
      .get('/stream', (req, res, next) => {
        Object.defineProperty(res, 'writableNeedDrain', { get: () => backlogged });
        // Registered before the stream's own listener, and resolved after it ran.
        closed.push(new Promise((resolve) => res.on('close', () => resolve())));
        void host.stream().then((reply) => reply.execute(req, res)).catch(next);
      })
      .listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    clock.restore();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('unsubscribes, clears its timer and frees its slot when the client leaves', async () => {
    const delivered = sinon.spy();
    const subscribe = store.subscribe.bind(store);
    sinon.stub(store, 'subscribe').callsFake((listener) => subscribe((summary) => { delivered(); listener(summary); }));
    for (let i = 0; i <= MAX_TRACE_STREAMS; i++) {
      (await openSse(port, '/stream', 'bob')).close();
      await closed[i];
    }
    finish('1', 'after every stream closed');
    expect([delivered.callCount, clock.countTimers()]).to.deep.eq([0, 0]);
  });

  it('skips an event while the client is not draining, and closes the stream after its lifetime', async () => {
    const stream = await openSse(port, '/stream', 'bob');
    backlogged = true;
    finish('1', 'skipped');
    backlogged = false;
    finish('2', 'sent');
    expect((await stream.next()).id).to.eq(traceIdOf('2'));
    clock.tick(TRACE_STREAM_MAX_MS);
    await closed[0];
    expect(clock.countTimers()).to.eq(0);
  });
});
