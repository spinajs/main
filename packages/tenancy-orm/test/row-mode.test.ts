import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TenantMismatch, TenantRequired } from '@spinajs/tenancy';
import { bootApp } from './support/app.js';
import { Carrier, Invoice, InvoiceLine, Note, Orphan } from './support/models.js';
import { everywhere, inTenant } from './support/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const codes = (rows: readonly Invoice[]): string[] => rows.map((row) => row.code).sort();
const allInvoices = (): Promise<Invoice[]> => everywhere(() => Invoice.query());

describe('TenantScopeMiddleware, row mode', function () {
  this.timeout(30_000);

  let app: TestApp;
  let driver: OrmDriver;

  before(async () => {
    app = await bootApp();
    const connection = (await app.resolve(Orm)).Connections.get('default');
    if (!connection) throw new Error('no default connection');
    driver = connection;
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await everywhere(async () => {
      await Invoice.destroy().where('Id', '>', 0);
      await InvoiceLine.destroy().where('Id', '>', 0);
      await Note.destroy().where('Id', '>', 0);
    });
    await Carrier.destroy().where('Id', '>', 0);
    await inTenant('t1', () => Invoice.insert({ code: 'A-1', status: 'open' }));
    await inTenant('t2', () => Invoice.insert([{ code: 'B-1', status: 'open' }, { code: 'B-2', status: 'paid' }]));
  });

  it('stamps the tenant on every inserted row and confines a select', async () => {
    expect(codes(await inTenant('t1', () => Invoice.where('status', 'open')))).to.deep.eq(['A-1']);
    expect((await allInvoices()).map((row) => `${row.code}:${row.tenant_id}`).sort()).to.deep.eq(['A-1:t1', 'B-1:t2', 'B-2:t2']);
  });

  it('keeps an orWhere inside the tenant', async () => {
    const rows = await inTenant('t1', () => Invoice.where('status', 'void').orWhere('status', 'open').orWhere('status', 'paid'));
    expect(codes(rows)).to.deep.eq(['A-1']);
  });

  it('confines an update and a delete', async () => {
    await inTenant('t1', () => Invoice.update({ status: 'void' }).where('status', 'open'));
    expect(codes((await allInvoices()).filter((row) => row.status === 'void'))).to.deep.eq(['A-1']);

    await inTenant('t2', () => Invoice.destroy().where('code', '!=', ''));
    expect(codes(await allInvoices())).to.deep.eq(['A-1']);
  });

  it('refuses the tenant of another tenant on an insert, and takes its own', async () => {
    await expect(inTenant('t1', () => Invoice.insert({ code: 'A-2', status: 'open', tenant_id: 't2' }))).to.be.rejectedWith(TenantMismatch, 'tenancy-orm: insert into invoice carries tenant_id "t2" inside tenant "t1"');
    await inTenant('t1', () => Invoice.insert({ code: 'A-3', status: 'open', tenant_id: 't1' }));
    expect(codes(await inTenant('t1', () => Invoice.query()))).to.deep.eq(['A-1', 'A-3']);
  });

  it('throws TenantRequired for every statement with no tenant scope', async () => {
    const required = (verb: string): string => `tenancy-orm: ${verb} on tenant table invoice of Invoice needs a tenant scope: run it inside runInTenant(), or leave the scope with a declared reason`;
    await expect(Promise.resolve(Invoice.where('status', 'open'))).to.be.rejectedWith(TenantRequired, required('select'));
    await expect(Promise.resolve(Invoice.insert({ code: 'X', status: 'open' }))).to.be.rejectedWith(TenantRequired, required('insert'));
    await expect(Promise.resolve(Invoice.update({ status: 'void' }).where('Id', '>', 0))).to.be.rejectedWith(TenantRequired, required('update'));
    await expect(Promise.resolve(Invoice.destroy().where('Id', '>', 0))).to.be.rejectedWith(TenantRequired, required('delete'));
    expect(await allInvoices()).to.have.length(3);
  });

  it('adds nothing in the all-tenants scope, where an insert names its tenant itself', async () => {
    await expect(everywhere(() => Invoice.insert({ code: 'X', status: 'open' }))).to.be.rejectedWith(TenantRequired, 'tenancy-orm: insert into invoice in the all-tenants scope must set tenant_id on every row');
    await everywhere(() => Invoice.insert({ code: 'C-1', status: 'open', tenant_id: 't3' }));
    expect(codes(await inTenant('t3', () => Invoice.query()))).to.deep.eq(['C-1']);
    expect(await allInvoices()).to.have.length(4);
  });

  it('filters a hasMany populate as the query of its own that it is', async () => {
    const [invoice] = await inTenant('t1', () => Invoice.where('code', 'A-1'));
    await inTenant('t1', () => InvoiceLine.insert({ invoice_id: invoice.Id, sku: 'own' }));
    // A row of another tenant that points at this invoice: only a tenant predicate on the relation query keeps it out.
    await inTenant('t2', () => InvoiceLine.insert({ invoice_id: invoice.Id, sku: 'foreign' }));

    const [loaded] = await inTenant('t1', () => Invoice.where('code', 'A-1').populate('Lines'));
    expect(Array.from(loaded.Lines, (line) => line.sku)).to.deep.eq(['own']);
  });

  it("uses the column the model's @Tenant names", async () => {
    await inTenant('t1', () => Note.insert({ body: 'mine' }));
    await inTenant('t2', () => Note.insert({ body: 'theirs' }));
    const rows = await inTenant('t1', () => Note.query());
    expect(rows.map((row) => `${row.org}:${row.body}`)).to.deep.eq(['t1:mine']);
  });

  it('refuses a builder that does not go through the tenant model', async () => {
    const refused = (verb: string): string =>
      `tenancy-orm: ${verb} on tenant table invoice of Invoice does not go through the model's own query, so it is not filtered by tenant yet (v4-td-03-row-mode-conformance); query Invoice itself, or run it inside runAcrossTenants(reason)`;
    await expect(inTenant('t1', () => driver.select().from('invoice'))).to.be.rejectedWith(NotSupported, refused('select'));
    await expect(inTenant('t1', () => driver.insert().into('invoice').values({ code: 'raw', status: 'open', tenant_id: 't1' }))).to.be.rejectedWith(NotSupported, refused('insert'));
    await expect(inTenant('t1', () => driver.update().in('invoice').update({ status: 'void' }).where('Id', '>', 0))).to.be.rejectedWith(NotSupported, refused('update'));
    await expect(inTenant('t1', () => driver.del().from('invoice').where('Id', '>', 0))).to.be.rejectedWith(NotSupported, refused('delete'));
    await expect(inTenant('t1', () => driver.truncate('invoice'))).to.be.rejectedWith(NotSupported, refused('truncate'));
    // A builder that carries the tenant model and reads another table: the shape of a many-to-many populate.
    await expect(inTenant('t1', () => Invoice.query().from('carrier'))).to.be.rejectedWith(NotSupported, 'tenancy-orm: select on tenant table invoice of Invoice does not go through');
    await expect(Promise.resolve(driver.select().from('invoice'))).to.be.rejectedWith(TenantRequired, 'tenancy-orm: select on tenant table invoice of Invoice needs a tenant scope');
    expect(await everywhere(() => driver.select().from('invoice'))).to.have.length(3);
  });

  it('refuses a tenant model whose table has no tenant column', async () => {
    await expect(inTenant('t1', () => Orphan.query())).to.be.rejectedWith(InvalidOperation, 'tenancy-orm: table orphan of tenant model Orphan has no column tenant_id; declare the property on the model and run the migration that adds it');
  });

  it('leaves a model that is no tenant model alone, with and without a model on the builder', async () => {
    await Carrier.insert({ name: 'dhl' });
    expect((await Carrier.query()).map((row) => row.name)).to.deep.eq(['dhl']);
    expect(await Promise.resolve(driver.select().from('carrier'))).to.have.length(1);
  });
});
