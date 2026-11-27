import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { NotSupported } from '@spinajs/exceptions';
import { Orm, SelectQueryBuilder } from '@spinajs/orm';
import type { IQueryStatement, ISelectQueryBuilder, OrmDriver } from '@spinajs/orm';
import type { TestApp } from '@spinajs/testing';
import { TenantRequired, TenantSwitchDenied, runInTenant } from '@spinajs/tenancy';
import { TenantModel, TenantScopeMiddleware } from '../src/index.js';
import { register, unregisterTenantModel } from '../src/registry.js';
import { bootApp } from './support/app.js';
import { Carrier, Depot, Invoice, InvoiceLine, InvoiceTag, Tag, TenantOwned } from './support/models.js';
import { everywhere, inTenant } from './support/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const names = (rows: ReadonlyArray<{ name: string }>): string[] => rows.map((row) => row.name).sort();
const codes = (rows: ReadonlyArray<{ code: string }>): string[] => rows.map((row) => row.code).sort();
const required = 'tenancy-orm: select on tenant table invoice of Invoice needs a tenant scope';

// The SQL a statement compiles to once the tenant middleware ran on it, as it would before the driver call.
const tenancy = new TenantScopeMiddleware();
async function compiled(tenant: string, query: ISelectQueryBuilder<unknown>): Promise<string> {
  if (!(query instanceof SelectQueryBuilder)) throw new Error('not a select builder');
  await runInTenant(tenant, () => {
    tenancy.beforeQueryExecution(query);
    return Promise.resolve();
  });
  const { expression, bindings } = query.toDB();
  return `${expression ?? ''} [${(bindings ?? []).join(', ')}]`;
}

const invoiceCodes = () => Invoice.query().select('code');

describe('TenantScopeMiddleware, a tenant select inside another statement', function () {
  this.timeout(30_000);

  let app: TestApp;
  let driver: OrmDriver;
  let a1: Invoice;

  before(async () => {
    app = await bootApp();
    const connection = (await app.resolve(Orm)).Connections.get('default');
    if (!connection) throw new Error('no default connection');
    driver = connection;
  });

  after(async () => {
    await app?.dispose();
  });

  // t1 owns A-1; t2 owns B-1 and B-2, a line and a tag link that point at A-1. Carriers and depots are shared.
  beforeEach(async () => {
    await everywhere(async () => {
      for (const model of [Invoice, InvoiceLine, InvoiceTag, Tag]) await model.destroy().where('Id', '>', 0);
    });
    await Carrier.destroy().where('Id', '>', 0);
    await Depot.destroy().where('Id', '>', 0);
    await inTenant('t1', () => Invoice.insert({ code: 'A-1', status: 'open' }));
    await inTenant('t2', () => Invoice.insert([{ code: 'B-1', status: 'open' }, { code: 'B-2', status: 'paid' }]));
    const all = await everywhere(() => Invoice.query());
    const id = (code: string): number => all.find((row) => row.code === code)?.Id ?? 0;
    a1 = all.find((row) => row.code === 'A-1') ?? a1;
    await inTenant('t1', () => InvoiceLine.insert({ invoice_id: id('A-1'), sku: 'own' }));
    await inTenant('t2', () => InvoiceLine.insert([{ invoice_id: id('A-1'), sku: 'foreign' }, { invoice_id: id('B-1'), sku: 'b1' }]));
    await inTenant('t2', () => Tag.insert({ Id: 1, name: 'secret' }));
    await inTenant('t2', () => InvoiceTag.insert({ invoice_id: id('A-1'), tag_id: 1 }));
    await Carrier.insert(['A-1', 'B-1', 'B-2', 'none'].map((name) => ({ name })));
    // Each depot is its own parent, so a join to the parent reads the depot's own invoice.
    await Depot.insert([
      { Id: 1, name: 'dA1', invoice_id: id('A-1'), parent_id: 1 },
      { Id: 2, name: 'dB1', invoice_id: id('B-1'), parent_id: 2 },
      { Id: 3, name: 'dB2', invoice_id: id('B-2'), parent_id: 3 },
    ]);
  });

  describe('every embedding form, inside t1', () => {
    const forms: Record<string, [() => PromiseLike<ReadonlyArray<{ name: string }>>, string[]]> = {
      'whereIn(column, query)': [() => Carrier.query().whereIn('name', invoiceCodes()), ['A-1']],
      'whereNotIn(column, query)': [() => Carrier.query().whereNotIn('name', invoiceCodes()), ['B-1', 'B-2', 'none']],
      'whereExist(query): no oracle on a row of t2': [() => Carrier.query().whereExist(Invoice.query().where('code', 'B-2')), []],
      'whereNotExists(query)': [() => Carrier.query().whereNotExists(Invoice.query().where('code', 'B-2')), ['A-1', 'B-1', 'B-2', 'none']],
      "whereExist('belongsTo', callback)": [
        () =>
          Depot.query().whereExist('Invoice', function () {
            this.where('status', '!=', 'void');
          }),
        ['dA1'],
      ],
      "whereNotExists('belongsTo', callback)": [
        () =>
          Depot.query().whereNotExists('Invoice', function () {
            this.where('status', '!=', 'void');
          }),
        ['dB1', 'dB2'],
      ],
      'a nested group three deep, with whereNot': [
        () =>
          Carrier.query().where(function () {
            this.where(function () {
              this.whereNot(function () {
                this.whereNotIn('name', invoiceCodes());
              });
            });
          }),
        ['A-1'],
      ],
      'a join callback': [
        () =>
          // SQLite compares aliases without letter case, and the ORM aliases both sides of a self join `$depot$`
          Depot.query()
            .setAlias('d')
            .innerJoin('Parent', function () {
            this.whereIn('invoice_id', Invoice.query().select('Id'));
          }),
        ['dA1'],
      ],
      'a to-one populate callback': [
        () =>
          Depot.query().populate('Parent', function () {
            this.whereIn('invoice_id', Invoice.query().select('Id'));
          }),
        ['dA1'],
      ],
      'a sub-query inside a sub-query': [() => Carrier.query().whereIn('name', invoiceCodes().whereIn('Id', InvoiceLine.query().select('invoice_id').where('sku', 'foreign'))), []],
    };

    for (const [form, [run, expected]] of Object.entries(forms)) {
      it(form, async () => {
        expect(names(await inTenant('t1', run))).to.deep.eq(expected);
      });
    }

    it("whereExist('hasMany', callback) between tenant models", async () => {
      const rows = await inTenant('t1', () =>
        Invoice.query().whereExist('Lines', function () {
          this.where('sku', 'foreign');
        }),
      );
      expect(codes(rows)).to.deep.eq([]);
    });

    it("whereExist('manyToMany', callback): the junction select", async () => {
      const rows = await inTenant('t1', () =>
        Invoice.query().whereExist('Tags', function () {
          this.where('name', 'secret');
        }),
      );
      expect(codes(rows)).to.deep.eq([]);
    });

    it('a condition column', async () => {
      const rows = await inTenant('t1', () =>
        Carrier.query()
          .select('name')
          .selectCondition('mine', function () {
            this.whereIn('name', invoiceCodes());
          }),
      );
      expect(rows.filter((row) => Reflect.get(row, 'mine') === true).map((row) => row.name)).to.deep.eq(['A-1']);
    });
  });

  describe('every statement kind, inside t1', () => {
    const inCodes = () => Carrier.query().whereIn('name', invoiceCodes());

    it('first(), selectCount() and resultExists()', async () => {
      expect(await inTenant('t1', () => inCodes().where('name', 'B-1').first())).to.eq(undefined);
      expect(await inTenant('t1', () => inCodes().selectCount())).to.eq(1);
      expect(await inTenant('t1', () => Carrier.query().whereExist(Invoice.query().where('code', 'B-2')).resultExists())).to.eq(false);
    });

    it('an offset page, a keyset page, and the pages of a stream', async () => {
      expect(names(await inTenant('t1', () => inCodes().take(10).skip(0)))).to.deep.eq(['A-1']);
      const page = await inTenant('t1', () => inCodes().paginate({ orderBy: [['name', 'asc']], limit: 10 }));
      expect(names(page.items)).to.deep.eq(['A-1']);
      const read = async (): Promise<string[]> => {
        const streamed: string[] = [];
        for await (const row of inCodes().orderBy('Id').stream({ batchSize: 1 })) streamed.push(row.name);
        return streamed;
      };
      expect(await runInTenant('t1', read)).to.deep.eq(['A-1']);
      // inside a transaction the stream pages by keyset: every page is a clone that runs the hooks
      expect(await runInTenant('t1', () => driver.transaction(read))).to.deep.eq(['A-1']);
    });

    it('an update and a delete select their rows through t1 only', async () => {
      const updated = await inTenant('t1', () => Carrier.update({ name: 'X' }).whereIn('name', invoiceCodes().where('code', 'B-1')));
      expect(updated).to.deep.include({ RowsAffected: 0 });
      await inTenant('t1', () =>
        Depot.update({ name: 'touched' }).whereExist('Invoice', function () {
          this.where('code', 'B-2');
        }),
      );
      await inTenant('t1', () => Carrier.destroy().whereIn('name', invoiceCodes()));
      expect(names(await Carrier.query())).to.deep.eq(['B-1', 'B-2', 'none']);
      expect(names(await Depot.query())).to.deep.eq(['dA1', 'dB1', 'dB2']);
    });
  });

  describe('the scope', () => {
    it('throws TenantRequired for a tenant sub-query with no tenant scope, as for a statement', async () => {
      await expect(Promise.resolve(Carrier.query().whereIn('name', invoiceCodes()))).to.be.rejectedWith(TenantRequired, required);
      await expect(Promise.resolve(Carrier.query().whereExist(Invoice.query().where('code', 'B-2')))).to.be.rejectedWith(TenantRequired, required);
      await expect(Promise.resolve(Carrier.update({ name: 'X' }).whereIn('name', invoiceCodes()))).to.be.rejectedWith(TenantRequired, required);
      await expect(Promise.resolve(Depot.query().whereExist('Invoice', function () {}))).to.be.rejectedWith(TenantRequired, required);
      expect(names(await Carrier.query())).to.deep.eq(['A-1', 'B-1', 'B-2', 'none']);
    });

    it('adds nothing in the all-tenants scope', async () => {
      expect(names(await everywhere(() => Carrier.query().whereIn('name', invoiceCodes())))).to.deep.eq(['A-1', 'B-1', 'B-2']);
    });

    it('D5: .acrossTenants() widens the builder that carries it, not the statement around it nor its sub-queries', async () => {
      const widened = () => Carrier.query().whereIn('name', invoiceCodes().acrossTenants('carrier report'));
      expect(names(await inTenant('t1', widened))).to.deep.eq(['A-1', 'B-1', 'B-2']);
      expect(names(await widened())).to.deep.eq(['A-1', 'B-1', 'B-2']);

      const outer = () => Invoice.query().acrossTenants('invoice report').whereIn('code', invoiceCodes());
      expect(codes(await inTenant('t1', outer))).to.deep.eq(['A-1']);
      await expect(Promise.resolve(outer())).to.be.rejectedWith(TenantRequired, required);
    });

    describe('D5 in the sync() callback of #1148', () => {
      const skus = async (): Promise<string[]> => (await everywhere(() => InvoiceLine.query())).map((line) => line.sku).sort();
      const foreignSkus = () => InvoiceLine.query().select('sku').where('sku', 'foreign');

      it('widens the orphan delete and not its sub-query, on a connection without tenant settings', async () => {
        unregisterTenantModel(TenantOwned);
        register(TenantOwned, undefined, '@Tenant()');
        try {
          await inTenant('t1', () =>
            a1.Lines.sync(function () {
              this.acrossTenants('invoice merge').whereIn('sku', foreignSkus());
            }),
          );
          expect(await skus()).to.deep.eq(['b1', 'foreign', 'own']);

          await inTenant('t1', () =>
            a1.Lines.sync(function () {
              this.acrossTenants('invoice merge').whereIn('sku', foreignSkus().acrossTenants('invoice merge'));
            }),
          );
          expect(await skus()).to.deep.eq(['b1', 'own']);
        } finally {
          unregisterTenantModel(TenantOwned);
          register(TenantOwned, { rls: true }, '@Tenant()');
        }
      });

      it('refuses the sub-query in t1 inside the transaction the widened delete pinned, on a connection with tenant settings', async () => {
        const mixed = inTenant('t1', () =>
          a1.Lines.sync(function () {
            this.acrossTenants('invoice merge').whereIn('sku', foreignSkus());
          }),
        );
        await expect(mixed).to.be.rejectedWith(TenantSwitchDenied, 'the tenant scope changed from all to tenant:t1');
        expect(await skus()).to.deep.eq(['b1', 'foreign', 'own']);
      });
    });

    it('refuses a sub-query that reads a tenant table without the model inside a tenant', async () => {
      const raw = () => Carrier.query().whereIn('name', driver.select().select('code').from('invoice'));
      await expect(inTenant('t1', raw)).to.be.rejectedWith(NotSupported, "select on tenant table invoice of Invoice does not go through the model's own query");
      expect(names(await everywhere(raw))).to.deep.eq(['A-1', 'B-1', 'B-2']);
    });
  });

  describe('the SQL', () => {
    it('confines the sub-query once, after the grouped conditions, so a top-level OR inside it cannot escape', async () => {
      const sql = await compiled('t1', Carrier.query().whereIn('name', Invoice.query().select('code').where('status', 'open').orWhere('status', 'paid')));
      expect(sql).to.eq('SELECT * FROM `carrier` WHERE `name` IN ( SELECT `code` FROM `invoice` WHERE ( `status` = ? OR `status` = ? ) AND `tenant_id` = ? ) [open, paid, t1]');
    });

    it('confines a relation sub-query and a junction select under their aliases', async () => {
      const exists = await compiled(
        't1',
        Depot.query().whereExist('Invoice', function () {
          this.where('code', 'B-2');
        }),
      );
      expect(exists).to.eq(
        'SELECT * FROM `depot` WHERE `invoice_id` IS NOT NULL AND EXISTS ( SELECT * FROM `invoice` as `invoice_exists` WHERE ( `invoice_exists`.`code` = ? AND `invoice_exists`.`Id` = `depot`.`invoice_id` ) AND `invoice_exists`.`tenant_id` = ? ) [B-2, t1]',
      );
      const junction = await compiled('t1', Invoice.query().whereExist('Tags'));
      expect(junction).to.eq(
        'SELECT * FROM `invoice` WHERE ( EXISTS ( SELECT * FROM `invoice_tag` as `invoice_tag_exists` WHERE ( `invoice_tag_exists`.`invoice_id` = `invoice`.`Id` ) AND `invoice_tag_exists`.`tenant_id` = ? ) ) AND `tenant_id` = ? [t1, t1]',
      );
    });

    it('leaves a sub-query on a shared table as it is, in a tenant statement and in a shared one', async () => {
      expect(await compiled('t1', Invoice.query().whereIn('carrier_id', Carrier.query().select('Id')))).to.eq('SELECT * FROM `invoice` WHERE ( `carrier_id` IN ( SELECT `Id` FROM `carrier` ) ) AND `tenant_id` = ? [t1]');
      expect(await compiled('t1', Carrier.query().whereIn('name', TenantModel.query().select('id')))).to.eq('SELECT * FROM `carrier` WHERE `name` IN ( SELECT `id` FROM `tenants` ) []');
    });

    it('adds the tenant condition once: to a sub-query that ran on its own, to one used twice, and to a clone', async () => {
      const ran = invoiceCodes();
      expect(codes(await inTenant('t1', () => ran))).to.deep.eq(['A-1']);
      const once = 'SELECT * FROM `carrier` WHERE `name` IN ( SELECT `code` FROM `invoice` WHERE `tenant_id` = ? ) [t1]';
      expect(await compiled('t1', Carrier.query().whereIn('name', ran))).to.eq(once);

      const twice = invoiceCodes();
      const usedTwice = Carrier.query()
        .whereIn('name', twice)
        .orWhere(function () {
          this.whereIn('name', twice);
        });
      expect(await compiled('t1', usedTwice)).to.eq(
        'SELECT * FROM `carrier` WHERE `name` IN ( SELECT `code` FROM `invoice` WHERE `tenant_id` = ? ) OR ( `name` IN ( SELECT `code` FROM `invoice` WHERE `tenant_id` = ? ) ) [t1, t1]',
      );

      const outer = Carrier.query().whereIn('name', invoiceCodes());
      expect(names(await inTenant('t1', () => outer))).to.deep.eq(['A-1']);
      expect(await compiled('t1', outer.clone())).to.eq(once);
      expect(names(await inTenant('t1', () => outer.clone()))).to.deep.eq(['A-1']);
    });

    // The relation handlers correlate through a Lazy, which a rebinding clone of the group could not compile.
    it('runs a clone of a statement whose relation sub-query was confined', async () => {
      const outer = Depot.query().whereExist('Invoice', function () {
        this.where('code', '!=', '');
      });
      expect(names(await inTenant('t1', () => outer))).to.deep.eq(['dA1']);
      expect(await compiled('t1', outer.clone())).to.eq(
        'SELECT * FROM `depot` WHERE `invoice_id` IS NOT NULL AND EXISTS ( SELECT * FROM `invoice` as `invoice_exists` WHERE ( `invoice_exists`.`code` != ? AND `invoice_exists`.`Id` = `depot`.`invoice_id` ) AND `invoice_exists`.`tenant_id` = ? ) [, t1]',
      );
      expect(names(await inTenant('t1', () => outer.clone()))).to.deep.eq(['dA1']);
    });

    // authz-orm's refusal of a marked sub-query (order 90) walks the same members after this middleware (80).
    it('leaves every embedded builder where the walk of SubQuery and nested() finds it', async () => {
      const reachable = (statements: readonly IQueryStatement[]): object[] =>
        statements.flatMap((statement) => [...(statement.SubQuery ? [statement.SubQuery, ...reachable(statement.SubQuery.Statements)] : []), ...reachable(statement.nested?.() ?? [])]);
      const deepest = InvoiceLine.query().select('invoice_id');
      const inner = invoiceCodes().where('status', 'open').orWhere('status', 'paid').whereIn('Id', deepest);
      const outer = Carrier.query().where('name', 'A-1').orWhere('name', 'B-1').whereIn('name', inner);
      await compiled('t1', outer);
      expect(reachable(outer.Statements)).to.have.ordered.members([inner, deepest]);
      expect(tenancy.order).to.be.below(90);
    });

    it('runs a sub-query that was embedded first and then on its own with one tenant condition', async () => {
      const sub = invoiceCodes();
      expect(names(await inTenant('t1', () => Carrier.query().whereIn('name', sub)))).to.deep.eq(['A-1']);
      expect(await compiled('t1', sub)).to.eq('SELECT `code` FROM `invoice` WHERE `tenant_id` = ? [t1]');
      expect(codes(await inTenant('t1', () => sub))).to.deep.eq(['A-1']);
    });
  });
});
