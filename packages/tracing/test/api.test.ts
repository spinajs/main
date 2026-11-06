import 'mocha';
import { expect } from 'chai';
import { ROOT_CONTEXT, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';

import { DEFAULT_TRACING_OPTIONS, activeTraceIds, childTraceIds, ensureTracing, extractTraceContext, injectTraceContext, traceparentOf, tracer, withSpan } from '../src/index.js';
import { ID_ONLY_TRACE_FLAGS, resetTracing, useInMemorySpans } from '../src/testing.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const INBOUND = `00-${TRACE_ID}-${SPAN_ID}-01`;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
// Program open decision 1, closed with "keep E4": ids without recording are unsampled.
const ID_ONLY_SAMPLED = ID_ONLY_TRACE_FLAGS === '01';

describe('tracing api', () => {
  describe('without a registered provider', () => {
    before(() => resetTracing());

    it('round-trips a traceparent through the W3C propagator', () => {
      const carrier: Record<string, string> = {};
      injectTraceContext(carrier, extractTraceContext({ traceparent: INBOUND }, ROOT_CONTEXT));
      expect(carrier.traceparent).to.eq(INBOUND);
    });

    it('mints a child under an inbound context, and a new trace without one; neither is sampled', () => {
      const child = childTraceIds(extractTraceContext({ traceparent: INBOUND }, ROOT_CONTEXT));
      expect(child.traceId).to.eq(TRACE_ID);
      expect(child.spanId).to.match(HEX16).and.not.eq(SPAN_ID);
      expect(child.sampled).to.eq(ID_ONLY_SAMPLED);

      const fresh = childTraceIds(ROOT_CONTEXT);
      expect(fresh.traceId).to.match(HEX32);
      expect(fresh.spanId).to.match(HEX16);
      expect(fresh.sampled).to.eq(ID_ONLY_SAMPLED);
    });

    it('renders ids as a traceparent value', () => {
      expect(traceparentOf({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false })).to.eq(`00-${TRACE_ID}-${SPAN_ID}-00`);
      expect(traceparentOf({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true })).to.eq(INBOUND);
    });

    it('has no active ids', () => {
      expect(activeTraceIds()).to.eq(undefined);
    });
  });

  describe('with the Spina provider', () => {
    before(async () => {
      await resetTracing();
      ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'api-test' });
    });

    after(() => resetTracing());

    it('registers the W3C trace-context and baggage propagator globally', () => {
      expect(propagation.fields()).to.include.members(['traceparent', 'tracestate', 'baggage']);
    });

    it('round-trips a started span', () => {
      const span = tracer().startSpan('rt');
      const carrier: Record<string, string> = {};
      injectTraceContext(carrier, trace.setSpan(ROOT_CONTEXT, span));
      const remote = trace.getSpanContext(extractTraceContext(carrier, ROOT_CONTEXT))!;
      expect(remote.traceId).to.eq(span.spanContext().traceId);
      expect(remote.spanId).to.eq(span.spanContext().spanId);
      expect(remote.isRemote).to.eq(true);
      span.end();
    });

    it('exposes the ids of the span withSpan runs in, unsampled in id-only mode', async () => {
      const seen = await withSpan('outer', {}, (span) => ({ own: span.spanContext(), active: activeTraceIds() }));
      expect(seen.active).to.deep.eq({ traceId: seen.own.traceId, spanId: seen.own.spanId, sampled: ID_ONLY_SAMPLED });
      expect(activeTraceIds()).to.eq(undefined);
    });

    it('ignores a remote span context: its span id is the caller’s', () => {
      const remote = extractTraceContext({ traceparent: INBOUND }, ROOT_CONTEXT);
      expect(context.with(remote, () => activeTraceIds())).to.eq(undefined);
    });

    it('records the exception and sets ERROR when the callback throws', async () => {
      const spans = useInMemorySpans();
      try {
        let thrown: unknown;
        try {
          await withSpan('fails', {}, () => {
            throw new Error('boom');
          });
        } catch (err) {
          thrown = err;
        }
        expect((thrown as Error).message).to.eq('boom');
        const [span] = spans.byName('fails');
        expect(span.status).to.deep.eq({ code: SpanStatusCode.ERROR, message: 'boom' });
        expect(span.events.map((e) => e.name)).to.deep.eq(['exception']);
      } finally {
        await spans.detach();
      }
    });
  });
});
