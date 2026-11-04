import 'mocha';
import { expect } from 'chai';
import { trace } from '@opentelemetry/api';
import type { ProxyTracerProvider } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { tracingState } from '../src/index.js';
import { resetTracing, useInMemorySpans } from '../src/testing.js';

describe('bring-your-own SDK', function () {
  this.timeout(15000);

  const external = new BasicTracerProvider();
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

  it('has no hub, so useInMemorySpans refuses', () => {
    expect(() => useInMemorySpans()).to.throw(/external/);
  });
});
