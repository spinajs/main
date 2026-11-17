import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { InsertBehaviour } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TenantRequired } from '@spinajs/tenancy';
import { bootApp } from './support/app.js';
import { Depot, Invoice } from './support/models.js';
import { everywhere, inTenant } from './support/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const summary = async (): Promise<string[]> => (await everywhere(() => Invoice.query())).map((row) => `${row.code}:${row.tenant_id}:${row.status}`).sort();
const joined = (path: string): string =>
  `tenancy-orm: populate('${path}') on Depot joins a tenant model on the same statement, and a joined table is not filtered by tenant yet (v4-td-03-row-mode-conformance); load it with a query of its own`;

describe('TenantScopeMiddleware, what it refuses', function () {
  this.timeout(30_000);

  let app: TestApp;

  before(async () => {
    app = await bootApp();
  });

  after(async () => {
    await app?.dispose();
  });

  beforeEach(async () => {
    await everywhere(() => Invoice.destroy().where('Id', '>', 0));
    await Depot.destroy().where('Id', '>', 0);
    await inTenant('t1', () => Invoice.insert({ code: 'A-1', status: 'open' }));
    await inTenant('t2', () => Invoice.insert({ code: 'B-1', status: 'open' }));
  });

  it('refuses an update that writes the tenant column, in any letter case and in every scope', async () => {
    const refused = 'tenancy-orm: update of invoice writes the tenant column tenant_id; a row never changes its tenant';
    await expect(inTenant('t1', () => Invoice.update({ tenant_id: 't2' }).where('code', 'A-1'))).to.be.rejectedWith(InvalidOperation, refused);
    await expect(inTenant('t1', () => Invoice.update({}).update({ TENANT_ID: 't2' }).where('code', 'A-1'))).to.be.rejectedWith(InvalidOperation, refused);
    await expect(inTenant('t1', () => Invoice.update({}).increment('tenant_id').where('code', 'A-1'))).to.be.rejectedWith(InvalidOperation, refused);
    await expect(everywhere(() => Invoice.update({ tenant_id: 't2' }).where('code', 'A-1'))).to.be.rejectedWith(InvalidOperation, refused);
    await expect(Promise.resolve(Invoice.update({ tenant_id: 't1' }).where('code', 'A-1').acrossTenants('move'))).to.be.rejectedWith(InvalidOperation, refused);
    expect(await summary()).to.deep.eq(['A-1:t1:open', 'B-1:t2:open']);

    // archive() writes the whole row back, the tenant column with the value it already has.
    await inTenant('t1', () => Invoice.update({ tenant_id: 't1', status: 'void' }).where('code', 'A-1'));
    expect(await summary()).to.deep.eq(['A-1:t1:void', 'B-1:t2:open']);
  });

  it('keeps the rule that an update names its rows', async () => {
    const refused = 'tenancy-orm: update of invoice has no where clause; add .where(true) to update every row of the tenant';
    await expect(inTenant('t1', () => Invoice.update({ status: 'void' }))).to.be.rejectedWith(InvalidOperation, refused);
    await expect(inTenant('t1', () => Invoice.update({ status: 'void' }).where(function () {}))).to.be.rejectedWith(InvalidOperation, refused);
    await inTenant('t1', () => Invoice.update({ status: 'void' }).where(true));
    expect(await summary()).to.deep.eq(['A-1:t1:void', 'B-1:t2:open']);
  });

  it('refuses an upsert on a tenant model inside a tenant and takes an insert-or-ignore', async () => {
    const refused = 'tenancy-orm: insert into invoice with onDuplicate() or orReplace() could change a row of another tenant; upserts on tenant models land with v4-td-03-row-mode-conformance';
    const [b1] = await inTenant('t2', () => Invoice.where('code', 'B-1'));
    await expect(inTenant('t1', () => Invoice.insert({ code: 'A-9', status: 'open' }, InsertBehaviour.InsertOrUpdate))).to.be.rejectedWith(NotSupported, refused);
    await expect(inTenant('t1', () => Invoice.insert({ Id: b1.Id, code: 'A-9', status: 'open' }, InsertBehaviour.InsertOrReplace))).to.be.rejectedWith(NotSupported, refused);
    await inTenant('t1', () => Invoice.insert({ Id: b1.Id, code: 'A-9', status: 'open' }, InsertBehaviour.InsertOrIgnore));
    await inTenant('t1', () => Invoice.insert({ code: 'A-2', status: 'open' }, InsertBehaviour.InsertOrIgnore));
    expect(await summary()).to.deep.eq(['A-1:t1:open', 'A-2:t1:open', 'B-1:t2:open']);
  });

  describe('a to-one populate of a tenant model from a select of a shared model (B13)', () => {
    beforeEach(async () => {
      const [a1] = await inTenant('t1', () => Invoice.where('code', 'A-1'));
      const [b1] = await inTenant('t2', () => Invoice.where('code', 'B-1'));
      await Depot.insert({ Id: 1, name: 'root' });
      await Depot.insert([
        { Id: 2, name: 'a', parent_id: 1, invoice_id: a1.Id },
        { Id: 3, name: 'b', parent_id: 1, invoice_id: b1.Id },
      ]);
      await Depot.insert({ Id: 4, name: 'x', parent_id: 3 });
    });

    it('refuses it inside a tenant, at depth one and two and in a to-many populate, and needs a scope', async () => {
      await expect(inTenant('t1', () => Depot.query().populate('Invoice'))).to.be.rejectedWith(NotSupported, joined('Invoice'));
      await expect(inTenant('t1', () => Depot.where('name', 'x').populate('Parent', function () {
        this.populate('Invoice');
      }))).to.be.rejectedWith(NotSupported, joined('Parent.Invoice'));
      await expect(inTenant('t1', () => Depot.where('name', 'root').populate('Children', function () {
        this.populate('Invoice');
      }))).to.be.rejectedWith(NotSupported, joined('Invoice'));
      await expect(Promise.resolve(Depot.query().populate('Invoice'))).to.be.rejectedWith(
        TenantRequired,
        "tenancy-orm: populate('Invoice') on Depot joins a tenant model and needs a tenant scope: run it inside runInTenant(), or leave the scope with a declared reason",
      );
    });

    it('runs it in the all-tenants scope, and a to-one populate of a shared model inside a tenant', async () => {
      const all = await everywhere(() => Depot.where('name', 'x').populate('Parent', function () {
        this.populate('Invoice');
      }));
      expect(all.map((row) => row.Parent.Value?.Invoice.Value?.code)).to.deep.eq(['B-1']);
      const parents = await inTenant('t1', () => Depot.where('name', 'x').populate('Parent'));
      expect(parents.map((row) => row.Parent.Value?.name)).to.deep.eq(['b']);
    });
  });
});
