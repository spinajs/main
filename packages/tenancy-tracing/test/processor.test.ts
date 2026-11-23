import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DI } from '@spinajs/di';
import { runAcrossTenants, runInTenant } from '@spinajs/tenancy';
import { SpinaAttr, tracingState, withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { TenantSpanProcessor } from '../src/index.js';

const noop = async (): Promise<void> => undefined;

const tenantOf = (spans: InMemorySpans, name: string): unknown => spans.byName(name)[0]?.attributes[SpinaAttr.Tenant];

// tenantScope() reads the Tenant key of this store, so a throwing getter makes the scope reader throw.
const throwingStore = (): object =>
  Object.defineProperty({}, 'Tenant', {
    enumerable: true,
    get: () => {
      throw new Error('broken store');
    },
  });

const inThrowingStore = <T>(fn: () => T): T => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<object>).run(throwingStore(), fn);

describe('TenantSpanProcessor', () => {
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

  it('sets spina.tenant.id to the tenant of the scope a span starts in', async () => {
    await runInTenant('acme', () => withSpan('in-acme', {}, noop));
    expect(tenantOf(spans, 'in-acme')).to.eq('acme');
  });

  it("sets '*' in the all-tenants scope", async () => {
    await runAcrossTenants('nightly reindex', () => withSpan('across', {}, noop));
    expect(tenantOf(spans, 'across')).to.eq('*');
  });

  it('sets nothing without a tenant scope', async () => {
    await withSpan('no-scope', {}, noop);
    expect(spans.byName('no-scope')).to.have.length(1);
    expect(spans.byName('no-scope')[0].attributes).to.not.have.property(SpinaAttr.Tenant);
  });

  it('sets it on every child span', async () => {
    await runInTenant('acme', () => withSpan('parent', {}, () => withSpan('child', {}, () => withSpan('grandchild', {}, noop))));
    expect(['parent', 'child', 'grandchild'].map((name) => tenantOf(spans, name))).to.deep.eq(['acme', 'acme', 'acme']);
    expect(spans.tree()[0].children[0].children[0].span.name).to.eq('grandchild');
  });

  it('never fails span creation when the scope cannot be read', async () => {
    const result = await inThrowingStore(() => withSpan('unreadable', {}, async () => 'ran'));
    expect(result).to.eq('ran');
    expect(spans.byName('unreadable')[0].attributes).to.not.have.property(SpinaAttr.Tenant);
  });

  it('does not throw from onStart itself when the scope cannot be read, so an SDK without the hub guard is safe too', () => {
    const set: string[] = [];
    const span = { setAttribute: (key: string) => set.push(key) };
    expect(() => inThrowingStore(() => new TenantSpanProcessor().onStart(span))).to.not.throw();
    expect(set).to.deep.eq([]);
  });
});
