import 'mocha';
import { expect } from 'chai';
import http from 'node:http';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { activeTraceIds, tracingState } from '@spinajs/tracing';
import type { TraceIds } from '@spinajs/tracing';
import { ID_ONLY_TRACE_FLAGS, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';
import { LogLevel, createLogMessageObject } from '@spinajs/log';

import { appPort, httpApp, req } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, Ok } from '../src/index.js';

const INBOUND_TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const INBOUND_SPAN_ID = '00f067aa0ba902b7';
const INBOUND = `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ITEM_SPAN = 'GET /tracing-t2/x/:id';

interface ItemBody {
  active?: TraceIds;
  log: { traceId?: string; spanId?: string };
}

@BasePath('tracing-t2')
class TracedController extends BaseController {
  @Get('x/:id')
  public item() {
    const entry = createLogMessageObject('', 'inside the action', LogLevel.Info, 'tracing-test', {});
    return new Ok({ active: activeTraceIds(), log: { traceId: entry.Variables.traceId, spanId: entry.Variables.spanId } });
  }

  @Get()
  public boom() {
    throw new Error('boom');
  }

  @Get()
  public async slow() {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return new Ok({});
  }
}

const traceparentOf = (res: { header: unknown }): string => (res.header as Record<string, string>).traceparent;

describe('HTTP server span', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({ register: (c) => c.register(TracedController).as(BaseController), resolve: [Intl, Controllers] });
    await (await app.resolve(HttpServer)).start();
  });

  after(() => app.dispose());

  it('is started by TracingBootstrapper when the app boots', () => {
    expect(tracingState().owner).to.eq('spinajs');
  });

  describe('recording', () => {
    let spans: InMemorySpans;

    beforeEach(() => {
      spans = useInMemorySpans();
    });

    afterEach(() => spans.detach());

    it('names the SERVER span after the route template and sets the HTTP attributes', async () => {
      const res = await req().get('tracing-t2/x/42');
      expect(res.status).to.eq(200);

      const server = await spans.waitFor(ITEM_SPAN);
      expect(server.kind).to.eq(SpanKind.SERVER);
      expect(server.attributes).to.include({ 'http.request.method': 'GET', 'http.route': '/tracing-t2/x/:id', 'url.path': '/tracing-t2/x/42', 'http.response.status_code': 200 });
      expect(server.status.code).to.eq(SpanStatusCode.UNSET);
    });

    it('sets ERROR status on a 500', async () => {
      const res = await req().get('tracing-t2/boom');
      expect(res.status).to.eq(500);

      const server = await spans.waitFor('GET /tracing-t2/boom');
      expect(server.status.code).to.eq(SpanStatusCode.ERROR);
      expect(server.attributes).to.include({ 'http.response.status_code': 500, 'error.type': '500' });
    });

    it('keeps the method as the name of a request no route matched', async () => {
      expect((await req().get('tracing-t2/nowhere')).status).to.eq(404);

      const server = await spans.waitFor('GET');
      expect(server.attributes).to.include({ 'url.path': '/tracing-t2/nowhere', 'http.response.status_code': 404 });
      expect(server.attributes).to.not.have.property('http.route');
      expect(server.status.code).to.eq(SpanStatusCode.UNSET);
    });

    it('ends the span of a request the client left as aborted', async () => {
      const request = http.request({ host: 'localhost', port: appPort(), path: '/tracing-t2/slow', method: 'GET' });
      request.on('error', () => {});
      request.end();
      setTimeout(() => request.destroy(), 50);

      const server = await spans.waitFor('GET /tracing-t2/slow');
      expect(server.attributes).to.include({ 'error.type': 'aborted' });
      expect(server.attributes).to.not.have.property('http.response.status_code');
      expect(server.status.code).to.eq(SpanStatusCode.ERROR);
    });

    it('continues an inbound traceparent and echoes the server span', async () => {
      const res = await req().get('tracing-t2/x/1').set('traceparent', INBOUND);

      const server = await spans.waitFor(ITEM_SPAN);
      expect(server.spanContext().traceId).to.eq(INBOUND_TRACE_ID);
      expect(server.parentSpanContext?.spanId).to.eq(INBOUND_SPAN_ID);
      expect(traceparentOf(res)).to.eq(`00-${INBOUND_TRACE_ID}-${server.spanContext().spanId}-01`);
    });

    it('puts the ids of the active span on log lines written in the action', async () => {
      const res = await req().get('tracing-t2/x/7');
      const body = res.body as ItemBody;

      const server = await spans.waitFor(ITEM_SPAN);
      expect(body.log.traceId).to.eq(server.spanContext().traceId);
      expect(body.log.spanId).to.eq(body.active?.spanId);
      const ofTrace = spans
        .spans()
        .filter((s) => s.spanContext().traceId === server.spanContext().traceId)
        .map((s) => s.spanContext().spanId);
      expect(ofTrace).to.include(body.active?.spanId);
    });
  });

  describe('id-only mode', () => {
    it('continues the trace, echoes traceparent and correlates log lines without recording', async () => {
      const res = await req().get('tracing-t2/x/9').set('traceparent', INBOUND);
      const body = res.body as ItemBody;

      const [, traceId, spanId, flags] = TRACEPARENT.exec(traceparentOf(res))!;
      expect(traceId).to.eq(INBOUND_TRACE_ID);
      expect(spanId).to.not.eq(INBOUND_SPAN_ID);
      expect(flags).to.eq(ID_ONLY_TRACE_FLAGS);
      expect(body.log.traceId).to.eq(INBOUND_TRACE_ID);
      expect(body.log.spanId).to.eq(body.active?.spanId);
    });
  });
});
