import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { InvalidOperation, NotSupported } from '@spinajs/exceptions';
import { executeSql, sql } from '@spinajs/orm';
import type { SqlFragment } from '@spinajs/orm';

import { TenantSessionSettings, generateTenantRls, registerTenantModel, tenantRlsMigrationSource, tenantRlsTables } from '../src/index.js';
import { unregisterTenantModel } from '../src/registry.js';
import { actingAs, bootPostgresRlsApp, bootRlsApp } from './support/rls-app.js';
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

/** The statements of the UP or DOWN list of a migration file that tenant:rls writes. */
function statementsOf(source: string, list: 'UP' | 'DOWN'): string[] {
  const body = source.split(`const ${list} = [\n`)[1]?.split('\n];')[0];
  if (body === undefined) throw new Error(`no ${list} list in the migration`);
  return body.split('\n').map((line) => {
    const statement: unknown = JSON.parse(line.trim().replace(/,$/, ''));
    if (typeof statement !== 'string') throw new Error(`not a statement: ${line}`);
    return statement;
  });
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    return messages(err);
  }
  throw new Error('the statement was not refused');
}

function rlsSuite(title: string, boot: () => Promise<RlsApp | undefined>, serverOnly: (app: () => RlsApp) => void = () => undefined): void {
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
      // the PostgreSQL suite boots with a replica of its own, which the later tests route model selects to
      const replicas = orm.Replicas.get('rls') ?? [];
      orm.Replicas.set('rls', [...replicas, replica]);
      try {
        expect(await inTenant('t1', () => provider.settings(replica))).to.deep.eq({ 'spina.tenant': 't1', 'spina.tenant_all': 'off' });
        for (const own of replicas) expect(await inTenant('t1', () => provider.settings(own))).to.deep.eq({ 'spina.tenant': 't1', 'spina.tenant_all': 'off' });
      } finally {
        if (replicas.length > 0) orm.Replicas.set('rls', replicas);
        else orm.Replicas.delete('rls');
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

    it('refuses .acrossTenants() inside a tenant, where the database still sees that tenant', async () => {
      await expect(inTenant('t1', () => RlsInvoice.query().acrossTenants('monthly report'))).to.be.rejectedWith(InvalidOperation, 'inside runAcrossTenants(reason)');
      // with no scope the database is told nothing, so the widened statement would read no row
      await expect(Promise.resolve().then(() => RlsInvoice.query().acrossTenants('monthly report'))).to.be.rejectedWith(InvalidOperation, 'still sees none');
      expect(await everywhere(() => actingAs(app().appRole, () => RlsInvoice.query().acrossTenants('monthly report')))).to.have.length(SEEDED);
    });

    it('keeps the tenant of the scope for raw SQL in a transaction and for every page of stream()', async () => {
      const { appRole, driver } = app();
      const expected = async (tenant: string): Promise<number[]> => ids(await inTenant(tenant, () => RlsInvoice.query().orderBy('Id')));
      const inTransaction = await inTenant('t2', () => actingAs(appRole, () => driver.transaction(async () => [await rawInvoices(), await rawInvoices()])));
      expect(inTransaction.map(ids)).to.deep.eq([await expected('t2'), await expected('t2')]);
      const streamed: number[] = [];
      await inTenant('t1', () =>
        actingAs(appRole, async () => {
          for await (const row of RlsInvoice.query().orderBy('Id').stream({ batchSize: 4 })) streamed.push(Number(row.Id));
        }),
      );
      expect(streamed).to.deep.eq(await expected('t1'));
    });

    it('answers the catalog queries of the docs: the tables are protected and the acting role is subject to them', async () => {
      const { appRole } = app();
      type TableRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; tenant_policy: number | string };
      const tables = await executeSql(
        sql<TableRow>`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'spina_tenant_isolation') AS tenant_policy
        FROM pg_class c WHERE c.relname IN ('rls_invoice', 'rls_memo', 'rls_placed') ORDER BY c.relname`,
        { connection: 'rls' },
      );
      expect(tables.map((t) => [t.relname, t.relrowsecurity, t.relforcerowsecurity, Number(t.tenant_policy)])).to.deep.eq([
        ['rls_invoice', true, true, 1],
        ['rls_memo', true, true, 1],
        ['rls_placed', false, false, 0],
      ]);
      type RoleRow = { rolsuper: boolean; rolbypassrls: boolean };
      const roleOf = (): Promise<RoleRow[]> => executeSql(sql<RoleRow>`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`, { connection: 'rls' });
      expect(await actingAs(appRole, roleOf)).to.deep.eq([{ rolsuper: false, rolbypassrls: false }]);
      // the connecting user is exempt from every policy: what it reads only the middleware confines
      expect(await roleOf()).to.deep.eq([{ rolsuper: true, rolbypassrls: true }]);
    });

    it('fails the migration at CREATE POLICY for a tenant column that is not text', async () => {
      await app().sql(`CREATE TABLE "rls_uuid" ("tenant_id" uuid NOT NULL)`);
      const statements = generateTenantRls([{ table: 'rls_uuid', column: 'tenant_id', connection: 'rls' }]).up;
      const run = async (): Promise<void> => {
        for (const statement of statements) await app().sql(statement);
      };
      expect(await refusal(run())).to.match(/operator does not exist: uuid = text/);
    });

    it('runs the written migration up twice, down and up, and down leaves another feature its policy and row level security', async () => {
      const { appRole, driver } = app();
      const names = ['rls_down_plain', 'rls_down_shared'];
      for (const table of names) await app().sql(`CREATE TABLE "${table}" ("tenant_id" varchar(64) NOT NULL)`);
      const tables = names.map((table) => ({ table, column: 'tenant_id', connection: 'rls' }));
      const source = tenantRlsMigrationSource(generateTenantRls(tables, { bypassRole: appRole }), 'TenantRls_2026_11_26_00_00_00', 'rls');
      const apply = async (list: 'UP' | 'DOWN'): Promise<void> => {
        for (const statement of statementsOf(source, list)) await driver.schema().raw(statement);
      };
      type StateRow = { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string };
      const state = (): Promise<StateRow[]> =>
        executeSql(
          sql<StateRow>`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
           COALESCE((SELECT string_agg(p.polname::text, ',' ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid = c.oid), '') AS policies
          FROM pg_class c WHERE c.relname IN ('rls_down_plain', 'rls_down_shared') ORDER BY c.relname`,
          { connection: 'rls' },
        );
      const tenantPolicies = 'spina_tenant_isolation,spina_tenant_open';
      try {
        await apply('UP');
        await apply('UP');
        await app().sql(`CREATE POLICY "other_feature_read" ON "rls_down_shared" AS PERMISSIVE FOR SELECT USING (true)`);
        await apply('DOWN');
        expect(await state()).to.deep.eq([
          { relname: 'rls_down_plain', relrowsecurity: false, relforcerowsecurity: false, policies: '' },
          { relname: 'rls_down_shared', relrowsecurity: true, relforcerowsecurity: true, policies: 'other_feature_read' },
        ]);
        await apply('UP');
        expect(await state()).to.deep.eq([
          { relname: 'rls_down_plain', relrowsecurity: true, relforcerowsecurity: true, policies: tenantPolicies },
          { relname: 'rls_down_shared', relrowsecurity: true, relforcerowsecurity: true, policies: `other_feature_read,${tenantPolicies}` },
        ]);
      } finally {
        for (const table of names) await app().sql(`DROP TABLE IF EXISTS "${table}"`);
      }
    });

    serverOnly(app);
  });
}

/** What PGlite, one session in process, cannot show: a pool of clients that the tenants of concurrent requests share. */
function pooledClients(app: () => RlsApp): void {
  type PidRow = { Id: number; pid: number };
  // pg_sleep keeps each client busy, so the statements overlap on different clients of the pool
  const busyInvoices = (): Promise<PidRow[]> => executeSql(sql<PidRow>`SELECT "Id", pg_backend_pid() AS pid FROM "rls_invoice", pg_sleep(0.05) ORDER BY "Id"`, { connection: 'rls' });
  const usedPids = new Set<number>();

  it('shows each of several concurrent tenants on pooled clients only its own rows', async () => {
    const { appRole } = app();
    const expected = new Map<string, number[]>();
    for (const tenant of TENANTS) expected.set(tenant, ids(await inTenant(tenant, () => RlsInvoice.query().orderBy('Id'))));
    const runs = Array.from({ length: 24 }, (_, i) => TENANTS[i % TENANTS.length]);
    const results = await Promise.all(
      runs.map((tenant) =>
        inTenant(tenant, async () => ({
          tenant,
          raw: await actingAs(appRole, busyInvoices),
          model: ids(await actingAs(appRole, () => RlsInvoice.query().orderBy('Id'))),
        })),
      ),
    );
    for (const { tenant, raw, model } of results) {
      expect(ids(raw), tenant).to.deep.eq(expected.get(tenant));
      expect(model, tenant).to.deep.eq(expected.get(tenant));
      for (const row of raw) usedPids.add(Number(row.pid));
    }
    expect(usedPids.size).to.be.greaterThan(1);
  });

  it('leaves no tenant on a pooled client for the next statement, after a refused one too', async () => {
    const { appRole } = app();
    await inTenant('t1', async () => {
      expect(await refusal(actingAs(appRole, () => executeSql(sql`INSERT INTO "rls_invoice" ("tenant_id", "code") VALUES (${'t2'}, ${'x'})`, { connection: 'rls' })))).to.match(/row-level security/);
    });
    type SettingRow = { tenant: string | null; pid: number };
    const unscoped = await Promise.all(
      Array.from({ length: 24 }, () => executeSql(sql<SettingRow>`SELECT current_setting('spina.tenant', true) AS tenant, pg_backend_pid() AS pid FROM pg_sleep(0.05)`, { connection: 'rls' })),
    );
    const rows = unscoped.flat();
    expect(rows.map((r) => r.tenant ?? '')).to.deep.eq(rows.map(() => ''));
    expect(rows.some((r) => usedPids.has(Number(r.pid)))).to.eq(true);
    expect(await Promise.all(Array.from({ length: 8 }, () => actingAs(appRole, busyInvoices)))).to.deep.eq(Array.from({ length: 8 }, () => []));
  });
}

rlsSuite('PGlite', bootRlsApp);
rlsSuite('PostgreSQL', bootPostgresRlsApp, pooledClients);
