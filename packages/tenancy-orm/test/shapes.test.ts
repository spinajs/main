import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { NotSupported } from '@spinajs/exceptions';
import { Orm, extractModelDescriptor } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TenantMismatch, TenantRequired } from '@spinajs/tenancy';
import { confine } from '../src/confine.js';
import { bootApp } from './support/app.js';
import { Carrier, Folder, Invoice, InvoiceLine, InvoiceView, Ledger } from './support/models.js';
import { everywhere, inTenant } from './support/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const notOwned = (verb: string, table: string, model: string): string =>
  `tenancy-orm: ${verb} on tenant table ${table} of ${model} does not go through the model's own query, so it is not filtered by tenant yet (v4-td-03-row-mode-conformance); query ${model} itself, or run it inside runAcrossTenants(reason)`;
const allInvoices = async (): Promise<string[]> => (await everywhere(() => Invoice.query())).map((row) => `${row.code}:${row.tenant_id}`).sort();

describe('TenantScopeMiddleware, shapes it refuses or must not miss', function () {
  this.timeout(30_000);

  let app: TestApp;
  let driver: OrmDriver;

  before(async () => {
    app = await bootApp();
    const connection = (await app.resolve(Orm)).Connections.get('default');
    if (!connection) throw new Error('no default connection');
    driver = connection;
    await Carrier.insert([{ name: 'dhl' }, { name: 'ups' }]);
    const [dhl, ups] = await Carrier.query().orderBy('Id');
    await inTenant('t1', () => Invoice.insert({ code: 'A-1', status: 'open', carrier_id: dhl.Id }));
    await inTenant('t2', () => Invoice.insert({ code: 'B-1', status: 'open', carrier_id: ups.Id }));
  });

  after(async () => {
    await app?.dispose();
  });

  afterEach(async () => {
    await everywhere(() => Invoice.destroy().whereNotIn('code', ['A-1', 'B-1']));
  });

  it('refuses a to-one populate inside a tenant, with or without a callback', async () => {
    const refused =
      'tenancy-orm: select on tenant table invoice of Invoice populates the to-one relation Carrier, whose conditions are not filtered by tenant yet (v4-td-03-row-mode-conformance); load it in a query of its own, or run it inside runAcrossTenants(reason)';
    await expect(inTenant('t1', () => Invoice.where('status', 'open').populate('Carrier'))).to.be.rejectedWith(NotSupported, refused);
    // The callback's conditions join the main WHERE ungrouped when the relation compiles, after every hook: B-1 of t2 came back.
    await expect(
      inTenant('t1', () =>
        Invoice.where('status', 'open').populate('Carrier', function () {
          this.where('name', 'dhl').orWhere('name', 'ups');
        }),
      ),
    ).to.be.rejectedWith(NotSupported, refused);
    await expect(Promise.resolve(Invoice.query().populate('Carrier'))).to.be.rejectedWith(TenantRequired);
    expect(await everywhere(() => Invoice.query().populate('Carrier'))).to.have.length(2);
  });

  it('keeps an orWhere of a to-many populate callback inside the tenant', async () => {
    const [a1] = await inTenant('t1', () => Invoice.where('code', 'A-1'));
    await inTenant('t1', () => InvoiceLine.insert({ invoice_id: a1.Id, sku: 'own' }));
    await inTenant('t2', () => InvoiceLine.insert({ invoice_id: a1.Id, sku: 'foreign' }));
    const [loaded] = await inTenant('t1', () =>
      Invoice.where('code', 'A-1').populate('Lines', function () {
        this.where('sku', 'own').orWhere('sku', 'foreign');
      }),
    );
    expect(Array.from(loaded.Lines, (line) => line.sku)).to.deep.eq(['own']);
  });

  it('refuses a recursive query inside a tenant', async () => {
    const refused =
      'tenancy-orm: select on tenant table folder of Folder is a recursive query, whose recursive part is not filtered by tenant yet (v4-td-03-row-mode-conformance); walk the tree with queries of its own, or run it inside runAcrossTenants(reason)';
    await expect(inTenant('t1', () => Folder.where('name', 'a').withRecursive('parent_id', 'Id'))).to.be.rejectedWith(NotSupported, refused);
    await expect(Promise.resolve(Folder.where('name', 'a').withRecursive('parent_id', 'Id'))).to.be.rejectedWith(TenantRequired);
    // A @Recursive relation is a to-one relation: refused before its recursive query is built.
    await expect(inTenant('t1', () => Folder.where('name', 'a').populate('Parent'))).to.be.rejectedWith(NotSupported, 'populates the to-one relation Parent');
  });

  it('refuses a model that is no tenant model on a tenant table, for every verb', async () => {
    await expect(inTenant('t1', () => InvoiceView.query())).to.be.rejectedWith(NotSupported, notOwned('select', 'invoice', 'Invoice'));
    await expect(inTenant('t1', () => InvoiceView.insert({ code: 'V-1' }))).to.be.rejectedWith(NotSupported, notOwned('insert', 'invoice', 'Invoice'));
    await expect(inTenant('t1', () => InvoiceView.update({ code: 'V-2' }).where('Id', '>', 0))).to.be.rejectedWith(NotSupported, notOwned('update', 'invoice', 'Invoice'));
    await expect(inTenant('t1', () => InvoiceView.destroy().where('Id', '>', 0))).to.be.rejectedWith(NotSupported, notOwned('delete', 'invoice', 'Invoice'));
    expect(await everywhere(() => InvoiceView.query())).to.have.length(2);
  });

  it('refuses a builder on the table of a subclass of a tenant model, and filters the subclass', async () => {
    await expect(inTenant('t1', () => driver.select().from('ledger'))).to.be.rejectedWith(NotSupported, notOwned('select', 'ledger', 'TenantOwned'));
    await expect(inTenant('t1', () => driver.select().from('archived_note'))).to.be.rejectedWith(NotSupported, notOwned('select', 'archived_note', 'Note'));
    await inTenant('t1', () => Ledger.insert({ entry: 'mine' }));
    await inTenant('t2', () => Ledger.insert({ entry: 'theirs' }));
    expect((await inTenant('t1', () => Ledger.query())).map((row) => `${row.entry}:${row.tenant_id}`)).to.deep.eq(['mine:t1']);
  });

  it('matches a tenant table in any letter case', async () => {
    await expect(inTenant('t1', () => driver.select().from('INVOICE'))).to.be.rejectedWith(NotSupported, notOwned('select', 'invoice', 'Invoice'));
    await expect(inTenant('t1', () => Carrier.query().from('Invoice'))).to.be.rejectedWith(NotSupported, notOwned('select', 'invoice', 'Invoice'));
    expect((await inTenant('t1', () => Invoice.query().from('INVOICE'))).map((row) => row.code)).to.deep.eq(['A-1']);
  });

  it('refuses Model.truncate() inside a tenant', async () => {
    await expect(inTenant('t1', () => Promise.resolve(Invoice.truncate()))).to.be.rejectedWith(NotSupported, notOwned('truncate', 'invoice', 'Invoice'));
  });

  it('checks every row of a bulk insert', async () => {
    await expect(inTenant('t1', () => Invoice.insert([{ code: 'A-2', status: 'open' }, { code: 'A-3', status: 'open', tenant_id: 't2' }]))).to.be.rejectedWith(TenantMismatch, 'carries tenant_id "t2" inside tenant "t1"');
    await inTenant('t1', () => Invoice.insert([{ code: 'A-4', status: 'open', tenant_id: null }, { code: 'A-5', status: 'open' }]));
    await expect(everywhere(() => Invoice.insert([{ code: 'C-1', status: 'open', tenant_id: 't3' }, { code: 'C-2', status: 'open' }]))).to.be.rejectedWith(TenantRequired, 'must set tenant_id on every row');
    expect(await allInvoices()).to.deep.eq(['A-1:t1', 'A-4:t1', 'A-5:t1', 'B-1:t2']);
  });

  it('keeps a HAVING statement out of the group of the caller statements (B6)', () => {
    const code = extractModelDescriptor(Invoice)?.Columns.find((column) => column.Name === 'code');
    if (!code) throw new Error('no column code');
    code.Aggregate = true;
    try {
      const query = Invoice.where('status', 'open').where('code', 'A-1');
      confine(query, 'tenant_id', 't1');
      const sql = query.toDB();
      expect(Array.isArray(sql) ? sql : sql.expression).to.eq('SELECT * FROM `invoice` WHERE ( `status` = ? ) AND `tenant_id` = ? HAVING `code` = ?');
    } finally {
      code.Aggregate = false;
    }
  });
});
