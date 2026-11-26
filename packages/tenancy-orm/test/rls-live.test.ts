import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { NotSupported } from '@spinajs/exceptions';
import { executeSql, sql } from '@spinajs/orm';
import type { SqlFragment } from '@spinajs/orm';

import { TenantSessionSettings, generateTenantRls, registerTenantModel, tenantRlsTables } from '../src/index.js';
import { unregisterTenantModel } from '../src/registry.js';
import { actingAs, bootRlsApp } from './support/rls-app.js';
import type { RlsApp } from './support/rls-app.js';
import { RlsInvoice, RlsMemo, RlsPlaced, declareRlsModels, forgetRlsModels } from './support/rls-models.js';
import { everywhere, inTenant } from './support/scope.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

const TENANTS = ['t1', 't2', 't3'];
const SEEDED = 60;

/** The same spread of rows over the tenants on every run. */
function seedRows(): Array<{ tenant: string; code: string }> {
  let state = 20261125;
  return Array.from({ length: SEEDED }, (_, i) => {
    state = (state * 48271) % 2147483647;
    return { tenant: TENANTS[state % TENANTS.length], code: `c${i}` };
  });
}

type InvoiceRow = { Id: number; tenant_id: string };
const rawInvoices = (): Promise<InvoiceRow[]> => executeSql(sql<InvoiceRow>`SELECT "Id", "tenant_id" FROM "rls_invoice" ORDER BY "Id"`, { connection: 'rls' });
const rawWrite = (statement: SqlFragment): Promise<unknown[]> => executeSql(statement, { connection: 'rls' });
const ids = (rows: ReadonlyArray<{ Id: number }>): number[] => rows.map((row) => Number(row.Id));

/** The messages of an error and of the errors it wraps. */
function messages(err: unknown): string {
  if (!(err instanceof Error)) return '';
  const inner: unknown = Reflect.get(err, 'inner') ?? err.cause;
  return `${err.message} ${messages(inner)}`;
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    return messages(err);
  }
  throw new Error('the statement was not refused');
}

function rlsSuite(title: string, boot: () => Promise<RlsApp | undefined>): void {
  describe(`row level security of tenant tables (${title})`, function () {
    this.timeout(120_000);
    let rls: RlsApp | undefined;
    const app = (): RlsApp => {
      if (rls === undefined) throw new Error('the suite did not boot');
      return rls;
    };

    before(async function () {
      declareRlsModels();
      const booted = await boot();
      rls = booted;
      if (booted === undefined) return this.skip();
      const policies = generateTenantRls(
        tenantRlsTables().filter((t) => t.connection === 'rls'),
        { bypassRole: booted.appRole },
      );
      for (const statement of policies.up) await booted.sql(statement);
      for (const row of seedRows()) await inTenant(row.tenant, () => RlsInvoice.insert({ code: row.code }));
      for (const [tenant, author] of [['t1', 'ann'], ['t1', 'bob'], ['t2', 'ann']] as const) await inTenant(tenant, () => RlsMemo.insert({ author }));
      // A permissive policy of its own, the shape authz:rls writes, added after the tenant policies.
      await booted.sql(`CREATE POLICY "spina_memo_read" ON "rls_memo" FOR SELECT USING ("author" = current_setting('spina.author', true))`);
    });

    after(async () => {
      await rls?.dispose();
      forgetRlsModels();
    });

    it('lists every row-mode table with rls, with its tenant column and connection', () => {
      expect(tenantRlsTables().filter((t) => t.connection === 'rls')).to.have.deep.members([
        { table: 'rls_invoice', column: 'tenant_id', connection: 'rls' },
        { table: 'rls_memo', column: 'tenant_id', connection: 'rls' },
      ]);
    });

    it('leaves out a schema-mode model', function () {
      try {
        registerTenantModel(RlsPlaced, { isolation: 'schema', column: false });
      } catch (err) {
        // a base without schema mode refuses the declaration
        if (err instanceof NotSupported) return this.skip();
        throw err;
      }
      try {
        expect(tenantRlsTables().map((t) => t.table)).not.to.include('rls_placed');
      } finally {
        unregisterTenantModel(RlsPlaced);
      }
    });

    it('sends the tenant of the scope, and nothing outside a scope or without a model with rls', async () => {
      const provider = new TenantSessionSettings();
      const { driver } = app();
      expect(await provider.settings(driver)).to.eq(undefined);
      expect(await inTenant('t1', () => provider.settings(driver))).to.deep.eq({ 'spina.tenant': 't1', 'spina.tenant_all': 'off' });
      expect(await everywhere(() => provider.settings(driver))).to.deep.eq({ 'spina.tenant': '', 'spina.tenant_all': 'on' });
      forgetRlsModels();
      try {
        expect(await inTenant('t1', () => provider.settings(driver))).to.eq(undefined);
      } finally {
        declareRlsModels();
      }
      // A model select runs on a read replica, a driver of its own: it must carry the tenant of its primary.
      const { orm } = app();
      const replica = orm.Connections.get('sqlite');
      if (replica === undefined) throw new Error('no sqlite connection');
      expect(await inTenant('t1', () => provider.settings(replica))).to.eq(undefined);
      orm.Replicas.set('rls', [replica]);
      try {
        expect(await inTenant('t1', () => provider.settings(replica))).to.deep.eq({ 'spina.tenant': 't1', 'spina.tenant_all': 'off' });
      } finally {
        orm.Replicas.delete('rls');
      }
    });

    it('shows a tenant through raw SQL exactly the rows the middleware shows', async () => {
      const { appRole } = app();
      let total = 0;
      for (const tenant of TENANTS) {
        const viaMiddleware = ids(await inTenant(tenant, () => RlsInvoice.query().orderBy('Id')));
        expect(ids(await inTenant(tenant, () => actingAs(appRole, rawInvoices))), tenant).to.deep.eq(viaMiddleware);
        expect(ids(await inTenant(tenant, () => actingAs(appRole, () => RlsInvoice.query().orderBy('Id')))), tenant).to.deep.eq(viaMiddleware);
        total += viaMiddleware.length;
      }
      expect(total).to.eq(SEEDED);
    });

    it('shows no row and takes no insert outside a tenant scope', async () => {
      const { appRole } = app();
      expect(await actingAs(appRole, rawInvoices)).to.deep.eq([]);
      expect(await refusal(actingAs(appRole, () => rawWrite(sql`INSERT INTO "rls_invoice" ("tenant_id", "code") VALUES (${'t1'}, ${'x'})`)))).to.match(/row-level security/);
    });

    it('keeps a raw write inside the tenant of the scope', async () => {
      const { appRole } = app();
      const rowsBefore = ids(await everywhere(() => RlsInvoice.query().orderBy('Id')));
      await inTenant('t1', async () => {
        expect(await refusal(actingAs(appRole, () => rawWrite(sql`INSERT INTO "rls_invoice" ("tenant_id", "code") VALUES (${'t2'}, ${'x'})`)))).to.match(/row-level security/);
        expect(await refusal(actingAs(appRole, () => rawWrite(sql`UPDATE "rls_invoice" SET "tenant_id" = ${'t2'}`)))).to.match(/row-level security/);
        expect(await actingAs(appRole, () => rawWrite(sql`DELETE FROM "rls_invoice" WHERE "tenant_id" = ${'t2'} RETURNING "Id"`))).to.deep.eq([]);
      });
      expect(ids(await everywhere(() => RlsInvoice.query().orderBy('Id')))).to.deep.eq(rowsBefore);
    });

    it('lets the all-tenants scope through for the bypass role only', async () => {
      const { appRole, otherRole } = app();
      expect(await everywhere(() => actingAs(appRole, rawInvoices))).to.have.length(SEEDED);
      expect(await everywhere(() => actingAs(otherRole, rawInvoices))).to.deep.eq([]);
      // another role's session that sets the flag itself, as a reporting tool could
      expect(await actingAs(otherRole, rawInvoices, { 'spina.tenant_all': 'on' })).to.deep.eq([]);
    });

    it('leaves a table with a permissive policy of its own to that policy, inside the tenant', async () => {
      const { appRole } = app();
      type MemoRow = { tenant_id: string; author: string };
      const memos = (author: string): Promise<MemoRow[]> =>
        actingAs(appRole, () => executeSql(sql<MemoRow>`SELECT "tenant_id", "author" FROM "rls_memo" ORDER BY "Id"`, { connection: 'rls' }), { 'spina.author': author });
      const viaMiddleware = (await inTenant('t1', () => RlsMemo.query().orderBy('Id'))).filter((m) => m.author === 'ann').map((m) => ({ tenant_id: m.tenant_id, author: m.author }));
      expect(await inTenant('t1', () => memos('ann'))).to.deep.eq(viaMiddleware);
      expect(viaMiddleware).to.deep.eq([{ tenant_id: 't1', author: 'ann' }]);
      expect(await inTenant('t2', () => memos('ann'))).to.deep.eq([{ tenant_id: 't2', author: 'ann' }]);
      // no row for an author nobody is: the tenant policy's fallback grant stepped back
      expect(await inTenant('t1', () => memos('carol'))).to.deep.eq([]);
    });
  });
}

rlsSuite('PGlite', bootRlsApp);
