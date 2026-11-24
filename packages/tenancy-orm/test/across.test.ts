import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidArgument, InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { Orm, OrmException } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TenantMismatch, TenantRequired, TenantSwitchDenied, runAcrossTenants, runInTenant } from '@spinajs/tenancy';
import { acrossTenantsReason } from '../src/index.js';
import { markAcrossTenants } from '../src/marker.js';
import { register, unregisterTenantModel } from '../src/registry.js';
import { bootApp } from './support/app.js';
import { Carrier, Folder, Invoice, InvoiceLine, InvoiceTag, InvoiceView, Orphan, Tag, TenantOwned } from './support/models.js';
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
      await InvoiceTag.destroy().where('Id', '>', 0);
      await Tag.destroy().where('Id', '>', 0);
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

  it('widens the orphan delete of a sync() only when its callback says so', async () => {
    const [a1] = await inTenant('t1', () => Invoice.where('code', 'A-1'));
    await inTenant('t1', () => InvoiceLine.insert({ invoice_id: a1.Id, sku: 'own' }));
    await inTenant('t2', () => InvoiceLine.insert({ invoice_id: a1.Id, sku: 'theirs' }));
    const [b1] = await inTenant('t2', () => Invoice.where('code', 'B-1'));
    await inTenant('t2', () => InvoiceLine.insert({ invoice_id: b1.Id, sku: 'other invoice' }));
    const skus = async (): Promise<string[]> => (await everywhere(() => InvoiceLine.query())).map((line) => line.sku).sort();

    await inTenant('t1', () => a1.Lines.sync());
    expect(await skus()).to.deep.eq(['other invoice', 'theirs']);
    await inTenant('t1', () => a1.Lines.sync(function () {}));
    expect(await skus()).to.deep.eq(['other invoice', 'theirs']);

    await inTenant('t1', () =>
      a1.Lines.sync(function () {
        this.acrossTenants('invoice merge');
      }),
    );
    expect(await skus()).to.deep.eq(['other invoice']);
  });

  describe('in the sync() of a many-to-many list', () => {
    let a1: Invoice;
    let kept: Tag;

    // A-1 links `kept` and `dropped` in t1 and in t2; B-1 links `dropped` in t2.
    beforeEach(async () => {
      [a1] = await inTenant('t1', () => Invoice.where('code', 'A-1'));
      const [b1] = await inTenant('t2', () => Invoice.where('code', 'B-1'));
      await inTenant('t1', async () => {
        await Tag.insert({ name: 'kept' });
        await Tag.insert({ name: 'dropped' });
      });
      const [dropped, keptTag] = await inTenant('t1', () => Tag.query().orderBy('name'));
      kept = keptTag;
      for (const [tenant, invoice, tag] of [
        ['t1', a1, kept],
        ['t1', a1, dropped],
        ['t2', a1, kept],
        ['t2', a1, dropped],
        ['t2', b1, dropped],
      ] as const) {
        await inTenant(tenant, () => InvoiceTag.insert({ invoice_id: invoice.Id, tag_id: tag.Id }));
      }
      a1.Tags.push(kept);
    });

    const links = async (): Promise<string[]> => {
      const names = new Map((await everywhere(() => Tag.query())).map((tag) => [tag.Id, tag.name]));
      const codes = new Map((await everywhere(() => Invoice.query())).map((invoice) => [invoice.Id, invoice.code]));
      const rows = await everywhere(() => InvoiceTag.query());
      return rows.map((row) => `${row.tenant_id} ${codes.get(row.invoice_id)} ${names.get(row.tag_id)}`).sort();
    };
    const everyLink = ['t1 A-1 dropped', 't1 A-1 kept', 't2 A-1 dropped', 't2 A-1 kept', 't2 B-1 dropped'];

    it('confines the junction delete when the callback does not widen it', async () => {
      await inTenant('t1', () => a1.Tags.sync());
      expect(await links()).to.deep.eq(['t1 A-1 kept', 't2 A-1 dropped', 't2 A-1 kept', 't2 B-1 dropped']);
      await inTenant('t1', () => a1.Tags.sync(function () {}));
      expect(await links()).to.deep.eq(['t1 A-1 kept', 't2 A-1 dropped', 't2 A-1 kept', 't2 B-1 dropped']);
    });

    it('widens the junction delete on a connection without tenant settings', async () => {
      unregisterTenantModel(TenantOwned);
      register(TenantOwned, undefined, '@Tenant()');
      try {
        await inTenant('t1', () =>
          a1.Tags.sync(function () {
            this.acrossTenants('invoice merge');
          }),
        );
      } finally {
        unregisterTenantModel(TenantOwned);
        register(TenantOwned, { rls: true }, '@Tenant()');
      }
      expect(await links()).to.deep.eq(['t1 A-1 kept', 't2 A-1 kept', 't2 B-1 dropped']);
    });

    // The read of existing links runs first, in the current scope, and the callback cannot reach it.
    it('refuses the widened junction delete after the read of existing links pinned the tenant', async () => {
      const widened = inTenant('t1', () =>
        a1.Tags.sync(function () {
          this.acrossTenants('invoice merge');
        }),
      );
      await expect(widened).to.be.rejectedWith(TenantSwitchDenied, 'the tenant scope changed from tenant:t1 to all');
      expect(await links()).to.deep.eq(everyLink);
    });

    it('needs a tenant scope for the read of existing links', async () => {
      const unscoped = a1.Tags.sync(function () {
        this.acrossTenants('invoice merge');
      });
      await expect(unscoped).to.be.rejectedWith(TenantRequired, 'select on tenant table invoice_tag');
      expect(await links()).to.deep.eq(everyLink);
    });

    it('runs the whole sync() across tenants inside runAcrossTenants()', async () => {
      await runAcrossTenants('invoice merge', () => a1.Tags.sync());
      expect(await links()).to.deep.eq(['t1 A-1 kept', 't2 A-1 kept', 't2 B-1 dropped']);
    });

    describe('a member with no link row', () => {
      let fresh: Tag;

      beforeEach(async () => {
        fresh = await inTenant('t1', async () => {
          await Tag.insert({ name: 'fresh' });
          return (await Tag.where('name', 'fresh'))[0];
        });
      });

      it('gets a link of the current tenant from sync() and from update()', async () => {
        a1.Tags.add(fresh);
        await inTenant('t1', () => a1.Tags.sync());
        expect(await links()).to.deep.eq(['t1 A-1 fresh', 't1 A-1 kept', 't2 A-1 dropped', 't2 A-1 kept', 't2 B-1 dropped']);

        await everywhere(() => InvoiceTag.destroy().where('tag_id', fresh.Id));
        await inTenant('t1', () => a1.Tags.update());
        expect(await links()).to.deep.eq(['t1 A-1 fresh', 't1 A-1 kept', 't2 A-1 dropped', 't2 A-1 kept', 't2 B-1 dropped']);
      });

      it('gets a link in the current tenant when it is linked only in another, and leaves that row', async () => {
        const [b1] = await inTenant('t2', () => Invoice.where('code', 'B-1'));
        b1.Tags.push(...(await inTenant('t1', () => Tag.where('name', 'dropped'))));

        await inTenant('t1', () => b1.Tags.sync());
        expect(await links()).to.deep.eq([...everyLink, 't1 B-1 dropped'].sort());
      });

      it('refuses junction data of another tenant inside a tenant and writes nothing', async () => {
        a1.Tags.add(fresh, { tenant_id: 't2' });
        await expect(inTenant('t1', () => a1.Tags.sync())).to.be.rejectedWith(TenantMismatch, 'carries tenant_id "t2" inside tenant "t1"');
        expect(await links()).to.deep.eq(everyLink);
      });

      // A junction model the caller gives is serialised as a model instance, which needs its tenant column set.
      it('refuses junction data without the tenant column inside a tenant and writes nothing', async () => {
        a1.Tags.add(fresh, { note: 'urgent' });
        await expect(inTenant('t1', () => a1.Tags.sync())).to.be.rejectedWith(OrmException, 'Field tenant_id cannot be null');
        expect(await links()).to.deep.eq(everyLink);

        a1.Tags.remove(fresh);
        a1.Tags.add(fresh, { note: 'urgent', tenant_id: 't1' });
        await inTenant('t1', () => a1.Tags.sync());
        expect(await links()).to.deep.eq(['t1 A-1 fresh', 't1 A-1 kept', 't2 A-1 dropped', 't2 A-1 kept', 't2 B-1 dropped']);
      });

      it('needs the tenant column on the junction data inside runAcrossTenants()', async () => {
        a1.Tags.add(fresh);
        await expect(runAcrossTenants('invoice merge', () => a1.Tags.sync())).to.be.rejectedWith(TenantRequired, 'must set tenant_id on every row');
        expect(await links()).to.deep.eq(everyLink);

        a1.Tags.remove(fresh);
        a1.Tags.add(fresh, { tenant_id: 't2' });
        await runAcrossTenants('invoice merge', () => a1.Tags.sync());
        expect(await links()).to.deep.eq(['t1 A-1 kept', 't2 A-1 fresh', 't2 A-1 kept', 't2 B-1 dropped']);
      });
    });
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

  it('ignores a mark written on a builder class prototype', async () => {
    const prototype = Reflect.getPrototypeOf(Invoice.query());
    if (prototype === null) throw new Error('no prototype');
    markAcrossTenants(prototype, 'every builder');
    try {
      expect(codes(await inTenant('t1', () => Invoice.query()))).to.deep.eq(['A-1']);
    } finally {
      Reflect.deleteProperty(prototype, Symbol.for('@spinajs/tenancy-orm:across'));
    }
  });

  it('takes a blank mark written past the method as no mark', async () => {
    const query = Invoice.query();
    markAcrossTenants(query, ' ');
    expect(codes(await inTenant('t1', () => query))).to.deep.eq(['A-1']);
  });
});
