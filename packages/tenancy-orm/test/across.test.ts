import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidArgument, InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { Orm } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TenantRequired, runInTenant } from '@spinajs/tenancy';
import { acrossTenantsReason } from '../src/index.js';
import { markAcrossTenants } from '../src/marker.js';
import { bootApp } from './support/app.js';
import { Carrier, Folder, Invoice, InvoiceLine, InvoiceView, Orphan } from './support/models.js';
import { everywhere, inTenant } from './support/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const codes = (rows: readonly Invoice[]): string[] => rows.map((row) => row.code).sort();

describe('.acrossTenants()', function () {
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
    });
    await inTenant('t1', () => Invoice.insert({ code: 'A-1', status: 'open' }));
    await inTenant('t2', () => Invoice.insert({ code: 'B-1', status: 'open' }));
  });

  it('reads the rows of every tenant, from inside a tenant and with no scope', async () => {
    expect(codes(await inTenant('t1', () => Invoice.query().acrossTenants('nightly dunning report')))).to.deep.eq(['A-1', 'B-1']);
    expect(codes(await Invoice.where('status', 'open').acrossTenants('nightly dunning report'))).to.deep.eq(['A-1', 'B-1']);
  });

  it('keeps the reason on the builder, on a clone and on the pages of a stream', async () => {
    const query = Invoice.query().orderBy('Id').acrossTenants('export');
    expect(acrossTenantsReason(query)).to.eq('export');
    expect(codes(await inTenant('t1', () => query.clone()))).to.deep.eq(['A-1', 'B-1']);

    const streamed: string[] = [];
    for await (const row of Invoice.query().orderBy('Id').acrossTenants('export').stream({ batchSize: 1 })) streamed.push(row.code);
    expect(streamed).to.deep.eq(['A-1', 'B-1']);
  });

  it('confines every page of a stream that has no escape, also inside a transaction', async () => {
    await inTenant('t1', () => Invoice.insert({ code: 'A-2', status: 'open' }));
    const read = async (): Promise<string[]> => {
      const streamed: string[] = [];
      for await (const row of Invoice.query().orderBy('Id').stream({ batchSize: 1 })) streamed.push(row.code);
      return streamed;
    };
    expect(await runInTenant('t1', read)).to.deep.eq(['A-1', 'A-2']);
    expect(await runInTenant('t1', () => driver.transaction(read))).to.deep.eq(['A-1', 'A-2']);
  });

  it('updates and deletes across tenants when the statement says so', async () => {
    await inTenant('t1', () => Invoice.update({ status: 'void' }).where('status', 'open').acrossTenants('migration 42'));
    expect((await everywhere(() => Invoice.query())).map((row) => row.status)).to.deep.eq(['void', 'void']);

    await Invoice.destroy().where('status', 'void').acrossTenants('migration 42');
    expect(await everywhere(() => Invoice.query())).to.have.length(0);
  });

  it('widens that one statement only: not a clone made before, not the next query, not a populated relation', async () => {
    const [a1] = await inTenant('t1', () => Invoice.where('code', 'A-1'));
    const [b1] = await inTenant('t2', () => Invoice.where('code', 'B-1'));
    await inTenant('t1', () => InvoiceLine.insert({ invoice_id: a1.Id, sku: 'own' }));
    await inTenant('t2', () => InvoiceLine.insert({ invoice_id: b1.Id, sku: 'theirs' }));

    const query = Invoice.query();
    const earlier = query.clone();
    query.acrossTenants('report');
    expect(acrossTenantsReason(earlier)).to.eq(undefined);
    expect(codes(await inTenant('t1', () => earlier))).to.deep.eq(['A-1']);
    expect(codes(await inTenant('t1', () => Invoice.query()))).to.deep.eq(['A-1']);

    const loaded = await inTenant('t1', () => Invoice.query().populate('Lines').acrossTenants('report'));
    const lines = Object.fromEntries(loaded.map((row) => [row.code, Array.from(row.Lines, (line) => line.sku)]));
    expect(lines).to.deep.eq({ 'A-1': ['own'], 'B-1': [] });
    await expect(Promise.resolve(Invoice.query().populate('Lines').acrossTenants('report'))).to.be.rejectedWith(TenantRequired, 'select on tenant table invoice_line');
  });

  it('leaves the shape rules of part 2 as they are in the all-tenants scope', async () => {
    // B9: another table on a tenant model passes in the all-tenants scope, and the to-one and recursive refusals are about the tenant predicate.
    expect(await inTenant('t1', () => Invoice.query().from('carrier').acrossTenants('report'))).to.be.an('array');
    expect(codes(await inTenant('t1', () => Invoice.query().populate('Carrier').acrossTenants('report')))).to.deep.eq(['A-1', 'B-1']);
    await expect(inTenant('t1', () => Invoice.query().populate('Carrier'))).to.be.rejectedWith(NotSupported, 'populates the to-one relation Carrier');
    await expect(inTenant('t1', () => Folder.query().populate('Parent'))).to.be.rejectedWith(NotSupported, 'populates the to-one relation Parent');
    await expect(inTenant('t1', () => Orphan.query().acrossTenants('report'))).to.be.rejectedWith(InvalidOperation, 'has no column tenant_id');
    expect(() => InvoiceView.query().acrossTenants('report')).to.throw(InvalidOperation, '(InvoiceView)');
  });

  it('needs a reason and a tenant model', () => {
    expect(() => Invoice.query().acrossTenants('  ')).to.throw(InvalidArgument, '.acrossTenants() needs a reason');
    expect(() => Carrier.query().acrossTenants('why')).to.throw(InvalidOperation, '.acrossTenants(): the query is not on a @Tenant model (Carrier)');
    expect(() => driver.select().from('invoice').acrossTenants('why')).to.throw(InvalidOperation, '(no model)');
  });

  it('takes a blank mark written past the method as no mark', async () => {
    const query = Invoice.query();
    markAcrossTenants(query, ' ');
    expect(codes(await inTenant('t1', () => query))).to.deep.eq(['A-1']);
  });
});
