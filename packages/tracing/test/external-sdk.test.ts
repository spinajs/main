import 'mocha';
import { expect } from 'chai';
import { ProxyTracerProvider, ROOT_CONTEXT, context, createContextKey, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { DEFAULT_TRACING_OPTIONS, ensureTracing, tracingState } from '../src/index.js';
import { resetTracing, useInMemorySpans } from '../src/testing.js';

const VALUE = createContextKey('external-sdk.test');
const activeValue = (): unknown => context.with(ROOT_CONTEXT.setValue(VALUE, 1), () => context.active().getValue(VALUE));

describe('bring-your-own SDK', function () {
  this.timeout(15000);

  describe('an SDK registered before the app boots', () => {
    const exporter = new InMemorySpanExporter();
    const external = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    let app: TestApp;

    before(async () => {
      await resetTracing();
      trace.setGlobalTracerProvider(external);
      app = await createTestApp({ config: {} });
    });

    after(async () => {
      await app.dispose();
      trace.disable();
      await resetTracing();
    });

    it('reports owner external and leaves the registered provider in place', () => {
      expect(tracingState()).to.deep.eq({ owner: 'external' });
      expect((trace.getTracerProvider() as ProxyTracerProvider).getDelegate()).to.eq(external);
    });

    it('exports nothing into that SDK while checking for it', () => {
      expect(exporter.getFinishedSpans()).to.deep.eq([]);
    });

    it('has no hub, so useInMemorySpans refuses', () => {
      expect(() => useInMemorySpans()).to.throw(/external/);
    });
  });

  // A provider without an SDK behind it passes the structural check, but its slot refuses a second registration.
  describe('a tracer provider slot that refuses the Spina provider', () => {
    before(async () => {
      await resetTracing();
      trace.setGlobalTracerProvider(new ProxyTracerProvider());
    });

    after(async () => {
      trace.disable();
      await resetTracing();
    });

    it('reports owner external and leaves no context manager or propagator behind', () => {
      expect(ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'refused' })).to.deep.eq({ owner: 'external' });
      expect(propagation.fields()).to.deep.eq([]);
      expect(activeValue()).to.eq(undefined);
    });
  });

  describe('a context manager and propagator registered by someone else', () => {
    before(async () => {
      await resetTracing();
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    });

    after(() => {
      context.disable();
      propagation.disable();
    });

    it('survive ensureTracing and resetTracing', async () => {
      expect(ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'foreign' }).owner).to.eq('spinajs');
      expect(propagation.fields()).to.deep.eq(['traceparent', 'tracestate']);
      await resetTracing();
      expect(propagation.fields()).to.deep.eq(['traceparent', 'tracestate']);
      expect(activeValue()).to.eq(1);
    });
  });
});
