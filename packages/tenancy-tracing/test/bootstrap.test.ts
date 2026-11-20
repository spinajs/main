import 'mocha';
import { expect } from 'chai';
import { runInTenant } from '@spinajs/tenancy';
import { SpinaAttr, tracer, tracingState, withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { TenantTracingBootstrapper } from '../src/index.js';

const noop = async (): Promise<void> => undefined;

describe('importing @spinajs/tenancy-tracing', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    await resetTracing();
    app = await createTestApp({ config: {} });
  });

  after(async () => {
    await app.dispose();
    await resetTracing();
  });

  it('attaches the processor to the tracing hub once Configuration is resolved, and only once', async () => {
    expect(tracingState().hub?.size).to.eq(1);
    const bootstrapper = await app.resolve(TenantTracingBootstrapper);
    bootstrapper.bootstrap();
    bootstrapper.bootstrap();
    expect(tracingState().hub?.size).to.eq(1);
  });

  it('keeps id-only tracing while nothing but the processor is attached', () => {
    const span = tracer().startSpan('id-only');
    expect(span.isRecording()).to.eq(false);
    span.end();
  });

  it('tags the spans an exporter on the hub records', async () => {
    const spans = useInMemorySpans();
    await runInTenant('acme', () => withSpan('tagged', {}, noop));
    expect(spans.byName('tagged')[0].attributes[SpinaAttr.Tenant]).to.eq('acme');
    await spans.detach();
  });
});
