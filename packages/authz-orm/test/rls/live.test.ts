import * as chai from 'chai';
import 'mocha';

import type { AuthorizationModel, ModelListPlan, PermissionDef, PermissionRegistry } from '@spinajs/authz';
import type { ModelBase } from '@spinajs/orm';

import { AccessResource, Owner } from '../../src/index.js';
import { RelationOwnerTerm } from '../../src/lists/relation-terms.js';
import { RlsPlanSource } from '../../src/plan/index.js';
import { generateRls, rlsResources } from '../../src/rls/index.js';
import { TestDb } from '../support/db.js';

const expect = chai.expect;

class Source extends RlsPlanSource {
  readonly model = 'rbac';
  plan(_model: AuthorizationModel, permission: PermissionDef): ModelListPlan {
    if (permission.name === 'doc:read') return { kind: 'terms', permit: [{ op: 'relation.owner', args: { principals: [] } }], deny: [] };
    if (permission.name === 'doc:update') return { kind: 'all' };
    return { kind: 'deny-all', reason: { code: 'role_denied' } };
  }
}

const models = [{ name: 'rbac', applies: () => true } as unknown as AuthorizationModel];
const permissions = { get: (name: string) => ({ name }) as PermissionDef } as unknown as PermissionRegistry;

/** Row level security on a live Postgres, as a non-superuser role (superusers skip RLS). Skipped without Postgres, like the rest of authz-orm's Postgres suites. */
describe('generated RLS on Postgres', function () {
  this.timeout(60000);
  const role = `spina_rls_${process.pid}`;
  let db: TestDb | undefined;
  let Doc: typeof ModelBase;
  let table: string;

  before(async function () {
    if (!(await TestDb.postgresReachable())) return this.skip();
    db = await TestDb.open({ postgres: true });
    Doc = await db.define(
      {
        name: 'RlsDoc',
        columns: { author_id: 'TEXT', title: 'TEXT' },
        rows: [
          { id: 'd1', author_id: 'alice', title: 'a' },
          { id: 'd2', author_id: 'bob', title: 'b' },
        ],
        decorate: (c, proto) => {
          AccessResource('doc', { rls: true })(c);
          Owner()(proto, 'author_id');
        },
      },
      'postgres',
    );
    table = db.table(Doc);
    const schema = db.driver('postgres').Options.Database;
    await db.raw(`DROP ROLE IF EXISTS "${role}"`, [], 'postgres');
    await db.raw(`CREATE ROLE "${role}" NOLOGIN`, [], 'postgres');
    await db.raw(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`, [], 'postgres');
    await db.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON "${table}" TO "${role}"`, [], 'postgres');
    const out = await generateRls({ models, permissions, resources: rlsResources([Doc]).map((r) => r.resource), sources: new Map([['rbac', new Source()]]), compilers: new Map([['relation.owner', new RelationOwnerTerm()]]), bypassRole: role });
    expect(out.diagnostics).to.deep.equal([]);
    for (const sql of out.up) await db.raw(sql, [], 'postgres');
  });

  after(async () => {
    if (db === undefined) return;
    await db.clear();
    await db.raw(`DROP OWNED BY "${role}"`, [], 'postgres').catch(() => undefined);
    await db.raw(`DROP ROLE IF EXISTS "${role}"`, [], 'postgres').catch(() => undefined);
    await db.close();
  });

  const as = <T>(settings: Record<string, string>, sql: string): Promise<T> =>
    db!.driver('postgres').transaction(async () => {
      await db!.raw(`SET LOCAL ROLE "${role}"`, [], 'postgres');
      for (const [name, value] of Object.entries(settings)) await db!.raw('SELECT set_config($1, $2, true)', [name, value], 'postgres');
      return (await db!.raw(sql, [], 'postgres')) as T;
    });
  const ids = async (settings: Record<string, string>) => (await as<{ id: string }[]>(settings, `SELECT id FROM "${table}" ORDER BY id`)).map((r) => r.id);

  it('shows a principal the rows the read plan gives it', async () => {
    expect(await ids({ 'spina.principal': JSON.stringify([{ type: 'user', id: 'alice' }]) })).to.deep.equal(['d1']);
    expect(await ids({ 'spina.principal': JSON.stringify([{ type: 'user', id: 'bob' }, { type: 'service', id: 'alice' }]) })).to.deep.equal(['d2']);
  });

  it('shows no row without session settings (fail closed)', async () => {
    expect(await ids({})).to.deep.equal([]);
  });

  it('applies the DELETE policy and leaves inserts to the application', async () => {
    const alice = { 'spina.principal': JSON.stringify([{ type: 'user', id: 'alice' }]) };
    expect(await as<unknown[]>(alice, `DELETE FROM "${table}" RETURNING id`)).to.deep.equal([]);
    // RETURNING would read the row back through the SELECT policy; the insert itself has no check.
    await as(alice, `INSERT INTO "${table}" (id, author_id) VALUES ('d3', 'carol')`);
    expect(await ids({ 'spina.principal': JSON.stringify([{ type: 'user', id: 'carol' }]) })).to.deep.equal(['d3']);
  });

  it('lets spina.bypass through only for the bypass role', async () => {
    expect(await ids({ 'spina.bypass': 'on' })).to.deep.equal(['d1', 'd2', 'd3']);
    // The bypass policy names one role only: any other role gets nothing from spina.bypass.
    const policy = (await db!.raw(`SELECT polname FROM pg_policy WHERE polname = 'spina_doc_bypass' AND polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = $1)]`, [role], 'postgres')) as unknown[];
    expect(policy).to.have.length(1);
  });
});
