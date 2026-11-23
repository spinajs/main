import 'mocha';
import { expect } from 'chai';
import { IdempotencyScopePart } from '@spinajs/http';
import { allTenantsScope, tenantScopeOf } from '@spinajs/tenancy';
import type { TestApp } from '@spinajs/testing';
import { TenantIdempotencyScope } from '../src/index.js';
import { tenancyHttpApp } from './support/source.js';

describe('tenant part of an idempotency scope', () => {
  let app: TestApp;

  before(async () => {
    app = await tenancyHttpApp();
  });

  after(async () => {
    await app?.dispose();
  });

  const partOf = (store: object) => new TenantIdempotencyScope().partOf(store);

  it('registers as an IdempotencyScopePart', () => {
    expect(app.container.getRegisteredNames(IdempotencyScopePart)).to.include('TenantIdempotencyScope');
  });

  it('names the tenant of a tenant scope, and one part for the all-tenants scope whatever its reason', () => {
    expect(partOf({ Tenant: tenantScopeOf('acme') })).to.eq('tenant:acme');
    expect(partOf({ Tenant: allTenantsScope('report') })).to.eq('tenant:*');
    expect(partOf({ Tenant: allTenantsScope('export') })).to.eq('tenant:*');
  });

  it('adds no part for a store without a scope, or with one that is not a tenant scope', () => {
    expect(partOf({})).to.eq(undefined);
    expect(partOf({ Tenant: { kind: 'tenant', tenant: { id: 'Not An Id' } } })).to.eq(undefined);
  });
});
