import 'mocha';
import { expect } from 'chai';
import { SpanKind, context, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { allTenantsScope, applyTenantScope, runInTenant, tenantScopeOf } from '@spinajs/tenancy';
import type { ITenantAsyncStorage } from '@spinajs/tenancy';
import { SpinaAttr, tracer, tracingState } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { TenantSpanProcessor } from '../src/index.js';

const tenantOf = (spans: InMemorySpans, name: string): unknown => spans.byName(name)[0]?.attributes[SpinaAttr.Tenant];

/** What TracingMiddleware and TenantMiddleware do: a SERVER span starts, then the glue applies the scope under it. */
function serveWithScope(name: string, store: ITenantAsyncStorage, apply: () => void, prepare: (span: Span) => void = () => undefined): void {
  const span = tracer().startSpan(name, { kind: SpanKind.SERVER });
  prepare(span);
  context.with(trace.setSpan(context.active(), span), apply);
  span.end();
  expect(store.Tenant).to.not.eq(undefined);
}

describe('TenantSpanProcessor on a server span', () => {
  let spans: InMemorySpans;
  let detachEnricher: () => Promise<void>;

  before(() => resetTracing());
  beforeEach(() => {
    spans = useInMemorySpans();
    const hub = tracingState().hub;
    if (!hub) throw new Error('useInMemorySpans() started no hub');
    detachEnricher = hub.add(new TenantSpanProcessor(), { enricher: true });
  });
  afterEach(async () => {
    await detachEnricher();
    await spans.detach();
  });
  after(() => resetTracing());

  it('tags a SERVER span started without a scope with the tenant the request glue applies under it', () => {
    const store: ITenantAsyncStorage = {};
    serveWithScope('GET', store, () => applyTenantScope(store, tenantScopeOf('acme')));
    expect(tenantOf(spans, 'GET')).to.eq('acme');
  });

  it("tags it '*' for an all-tenants route", () => {
    const store: ITenantAsyncStorage = {};
    serveWithScope('GET all', store, () => applyTenantScope(store, allTenantsScope('status page')));
    expect(tenantOf(spans, 'GET all')).to.eq('*');
  });

  it('does not tag an INTERNAL span that a tenant scope is entered under', async () => {
    const job = tracer().startSpan('job');
    await context.with(trace.setSpan(context.active(), job), () => runInTenant('acme', async () => undefined));
    job.end();
    expect(spans.byName('job')[0].attributes).to.not.have.property(SpinaAttr.Tenant);
  });

  it('never refuses the scope change when tagging the span throws', () => {
    const store: ITenantAsyncStorage = {};
    const breakSetAttribute = (span: Span): void => {
      Object.defineProperty(span, 'setAttribute', {
        value: () => {
          throw new Error('broken span');
        },
      });
    };
    expect(() => serveWithScope('GET broken', store, () => applyTenantScope(store, tenantScopeOf('acme')), breakSetAttribute)).to.not.throw();
    expect(store.Tenant).to.deep.eq({ kind: 'tenant', tenant: { id: 'acme' } });
  });
});
