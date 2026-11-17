import 'mocha';
import { expect } from 'chai';
import { SpanKind, context, trace } from '@opentelemetry/api';
import { tracer } from '@spinajs/tracing';
import { useInMemorySpans } from '@spinajs/tracing/testing';

import type { StudioCapabilities, StudioLogLine, StudioPage, TraceDetail, TraceSummary } from '../src/contracts/index.js';
import { startApp, stopApp } from './support/app.js';
import type { TestApp } from './support/app.js';
import { registerHeaderSource } from './support/principals.js';

// The access log line and the http errors of every request reach Studio, Studio's own included.
const LOGGER = {
  targets: [
    { name: 'Empty', type: 'ConsoleTarget' },
    { name: 'Studio', type: 'StudioLogTarget' },
  ],
  rules: [
    { name: '*', level: 'error', target: 'Empty' },
    { name: 'http.access', level: 'info', target: 'Studio' },
    { name: 'http', level: 'warn', target: 'Studio' },
  ],
};

describe('traces API', function () {
  this.timeout(30000);

  let app: TestApp;
  let unregister: () => void;
  const get = (path: string, user = 'bob') => app.request().get(path).set('Accept', 'application/json').set('x-user', user);

  // The server span ends in the last onFinish, after the access log line was written.
  async function settled(path: string, spanName: string) {
    const spans = useInMemorySpans();
    try {
      await get(path);
      await spans.waitFor(spanName, 10_000);
    } finally {
      await spans.detach();
    }
  }

  before(async () => {
    unregister = registerHeaderSource();
    app = await startApp({ config: { logger: LOGGER } });
  });

  after(async () => {
    await stopApp();
    unregister();
  });

  it('attaches the Studio processor to the tracing hub when Studio mounts', async () => {
    const body = (await get('/_studio/api/capabilities')).body as StudioCapabilities;
    expect(body.tracing).to.deep.eq({ owner: 'spinajs', recording: true });
    expect(body.features.traces).to.eq(true);
    expect(body.features.logs).to.eq(true);
  });

  it('lists a finished trace and answers its spans', async () => {
    const root = tracer().startSpan('GET /orders', { kind: SpanKind.SERVER, attributes: { 'http.route': '/orders', 'http.response.status_code': 200 } });
    tracer().startSpan('db.query', {}, trace.setSpan(context.active(), root)).end();
    root.end();
    const traceId = root.spanContext().traceId;

    const list = await get('/_studio/api/traces?route=/orders');
    expect(list.status).to.eq(200);
    expect((list.body as StudioPage<TraceSummary>).items[0]).to.include({ traceId, rootName: 'GET /orders', spanCount: 2, statusCode: 200, complete: true });

    const detail = await get(`/_studio/api/traces/${traceId}`);
    expect(detail.status).to.eq(200);
    expect((detail.body as TraceDetail).spans.map((s) => s.name).sort()).to.deep.eq(['GET /orders', 'db.query']);
    expect((detail.body as TraceDetail).logs).to.deep.eq([]);
  });

  it('never lists its own requests, in any letter case', async () => {
    await settled('/_studio/api/traces', 'GET /_studio/api/traces');
    await settled('/_STUDIO/API/TRACES', 'GET /_studio/api/traces');
    const names = ((await get('/_studio/api/traces')).body as StudioPage<TraceSummary>).items.map((t) => (t.route ?? t.rootName).toLowerCase());
    expect(names.some((n) => n.includes('/_studio'))).to.eq(false);
  });

  it('answers 404 for a trace that is not buffered and 400 for a malformed id or query', async () => {
    expect((await get(`/_studio/api/traces/${'f'.repeat(32)}`)).status).to.eq(404);
    expect((await get('/_studio/api/traces/not-a-trace')).status).to.eq(400);
    expect((await get('/_studio/api/traces?limit=0')).status).to.eq(400);
    expect((await get('/_studio/api/traces?limit=1&limit=2')).status).to.eq(400);
    expect((await get('/_studio/api/traces?status=maybe')).status).to.eq(400);
    expect((await get('/_studio/api/traces?from=yesterday')).status).to.eq(400);
    expect((await get('/_studio/api/logs?level=loud')).status).to.eq(400);
  });

  it('checks studio:read on every route', async () => {
    expect((await get('/_studio/api/traces', 'alice')).status).to.eq(403);
    expect((await get('/_studio/api/logs', 'alice')).status).to.eq(403);
  });

  it('answers the buffered log lines as a page', async () => {
    const res = await get('/_studio/api/logs?level=warn&limit=10');
    expect(res.status).to.eq(200);
    expect((res.body as StudioPage<StudioLogLine>).items).to.be.an('array');
  });

  it('buffers the log lines of other requests and never those of its own, in any letter case', async () => {
    await settled('/orders', 'GET');
    await settled('/_studio/api/logs', 'GET /_studio/api/logs');
    await settled('/_STUDIO/API/LOGS', 'GET /_studio/api/logs');
    await settled('/_STUDIO/api/traces/not-a-trace', 'GET /_studio/api/traces/:traceId');
    const lines = ((await get('/_studio/api/logs')).body as StudioPage<StudioLogLine>).items.map((l) => `${String(l.fields.path)} ${l.message}`.toLowerCase());
    expect(lines.filter((l) => l.includes('/orders'))).to.have.length(2);
    expect(lines.filter((l) => l.includes('/_studio'))).to.deep.eq([]);
    const warnings = ((await get('/_studio/api/logs?level=warn')).body as StudioPage<StudioLogLine>).items;
    expect(warnings.map((l) => [l.level, l.message.toLowerCase().includes('/orders')])).to.deep.eq([['error', true]]);
  });
});
