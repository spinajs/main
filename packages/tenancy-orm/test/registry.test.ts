import 'mocha';
import { expect } from 'chai';
import assert from 'node:assert/strict';
import { InvalidArgument, InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { ModelBase } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { Tenant, registerTenantModel, tenantModelOf, tenantModelOfTable, tenantModels } from '../src/index.js';
import { claimProcess } from '../src/once.js';
import { register, unregisterTenantModel } from '../src/registry.js';
import { bootApp } from './support/app.js';
import { Carrier, Invoice, InvoiceLine, Note } from './support/models.js';

class Plain extends ModelBase<Plain> {}
class Placed extends ModelBase<Placed> {}
class Special extends Invoice {}

describe('tenant model registry', function () {
  this.timeout(30_000);

  afterEach(() => {
    unregisterTenantModel(Plain);
    unregisterTenantModel(Placed);
  });

  it('registers a decorated model with the defaults', () => {
    expect(tenantModelOf(Invoice)).to.deep.eq({ model: Invoice, table: 'invoice', isolation: 'row', column: 'tenant_id', rls: false });
    expect(tenantModelOf(Note)?.column).to.eq('org');
    expect(tenantModelOf(Carrier)).to.eq(undefined);
    expect(tenantModelOf(undefined)).to.eq(undefined);
  });

  it('finds a tenant model by its table, and a subclass by its nearest registered ancestor', () => {
    expect(tenantModelOfTable('invoice_line')?.model).to.eq(InvoiceLine);
    expect(tenantModelOfTable('carrier')).to.eq(undefined);
    expect(tenantModelOf(Special)?.model).to.eq(Invoice);
    expect(tenantModels().map((entry) => entry.table)).to.include.members(['invoice', 'invoice_line', 'note']);
  });

  it('registers a model the package does not own, once', () => {
    registerTenantModel(Plain, { column: 'owner_org', rls: true });
    registerTenantModel(Plain, { rls: true, column: 'owner_org' });
    expect(tenantModelOf(Plain)).to.include({ column: 'owner_org', rls: true });
    expect(() => registerTenantModel(Plain, { column: 'other' })).to.throw(InvalidArgument, 'Plain is already registered as a tenant model with other options');
  });

  it('refuses a model that is no class and options it does not know', () => {
    expect(() => register('Plain', undefined, 'registerTenantModel()')).to.throw(InvalidArgument, 'registerTenantModel(): the model must be a class');
    expect(() => register(Plain, 'row', '@Tenant()')).to.throw(InvalidArgument, 'Plain: @Tenant(): options must be an object');
    expect(() => register(Plain, { colum: 'x' }, '@Tenant()')).to.throw(InvalidArgument, "Plain: @Tenant(): unknown option 'colum'");
    expect(() => register(Plain, { column: 'a b' }, '@Tenant()')).to.throw(InvalidArgument, 'Plain: @Tenant(): column must be a column name or false, got "a b"');
    expect(() => register(Plain, { rls: 'yes' }, '@Tenant()')).to.throw(InvalidArgument, 'Plain: @Tenant(): rls must be a boolean, got "yes"');
    expect(() => register(Plain, { isolation: 'database' }, '@Tenant()')).to.throw(InvalidArgument, `Plain: @Tenant(): isolation must be 'row' or 'schema', got "database"`);
  });

  it("accepts isolation 'schema' in the type and refuses it when the model is declared", () => {
    const refused = "isolation 'schema' is not available yet; it lands with schema placements (v4-td-05-placement-schema). Use isolation 'row'";
    expect(() => Tenant({ isolation: 'schema' })(Placed)).to.throw(NotSupported, `Placed: @Tenant(): ${refused}`);
    expect(() => registerTenantModel(Placed, { isolation: 'schema' })).to.throw(NotSupported, `Placed: registerTenantModel(): ${refused}`);
    expect(tenantModelOf(Placed)).to.eq(undefined);
  });

  it('refuses a row-mode model without a tenant column when it is first used', () => {
    registerTenantModel(Plain, { column: false });
    expect(() => tenantModelOf(Plain)).to.throw(InvalidArgument, "Plain: row isolation needs a tenant column; column: false is for isolation 'schema'");
  });

  it('refuses a second copy of the package', () => {
    const store = {};
    claimProcess(store, { package: 'first' });
    expect(() => claimProcess(store, { package: 'second' })).to.throw(InvalidOperation, 'tenancy-orm: another copy of @spinajs/tenancy-orm is already loaded in this process; load it once');
  });

  describe('tenancy.orm defaults', () => {
    let app: TestApp | undefined;

    afterEach(async () => {
      await app?.dispose();
      app = undefined;
    });

    it('lays the options of a model over tenancy.orm', async () => {
      app = await bootApp({ orm: { column: 'org_id', rls: true } });
      registerTenantModel(Plain);
      expect(tenantModelOf(Plain)).to.include({ column: 'org_id', rls: true });
      expect(tenantModelOf(Note)).to.include({ column: 'org', rls: true });
    });

    it("refuses tenancy.orm.isolation 'schema' when a tenant model is first used", async () => {
      app = await bootApp({ orm: { isolation: 'schema' } });
      expect(() => tenantModelOf(Invoice)).to.throw(NotSupported, "tenancy.orm: isolation 'schema' is not available yet; it lands with schema placements (v4-td-05-placement-schema). Use isolation 'row'");
    });

    it('refuses a tenancy.orm value of the wrong type when the application boots', async () => {
      await assert.rejects(bootApp({ orm: { rls: 'sometimes' } }), /tenancy\.orm\.rls must be boolean/);
      await assert.rejects(bootApp({ orm: { column: 'not a column' } }), /tenancy\.orm\.column must match pattern/);
    });
  });
});
