import * as chai from 'chai';
import 'mocha';

import type { AuthorizationModel, ModelListPlan, PermissionDef, PermissionRegistry } from '@spinajs/authz';
import type { IWhereBuilder } from '@spinajs/orm';

import { PlanTermCompiler, RlsPlanSource } from '../../src/plan/index.js';
import type { RlsSqlContext } from '../../src/plan/index.js';
import { RelationOwnerTerm } from '../../src/lists/relation-terms.js';
import { generateRls, rlsMigrationSource } from '../../src/rls/index.js';
import type { RlsGenerateInput, RlsResource } from '../../src/rls/index.js';

const expect = chai.expect;

class FlagTerm extends PlanTermCompiler {
  readonly op = 'test.flag';
  apply(_args: unknown, where: IWhereBuilder<unknown>): void {
    where.where(false);
  }
  renderSql(args: unknown, ctx: RlsSqlContext): string {
    return `${ctx.table}."flag" = ${ctx.literal((args as { flag: string }).flag)}`;
  }
}

/** Has no renderSql: what the database cannot evaluate. */
class OpaqueTerm extends PlanTermCompiler {
  readonly op = 'test.opaque';
  apply(_args: unknown, where: IWhereBuilder<unknown>): void {
    where.where(false);
  }
}

const model = (name: string, types: string[] = ['invoice']): AuthorizationModel => ({ name, applies: (_p: PermissionDef, t: string) => types.includes(t) }) as unknown as AuthorizationModel;

class Source extends RlsPlanSource {
  constructor(
    readonly model: string,
    private readonly plans: Record<string, ModelListPlan>,
  ) {
    super();
  }
  plan(_model: AuthorizationModel, permission: PermissionDef): ModelListPlan {
    const plan = this.plans[permission.name];
    if (plan === undefined) throw new Error(`no plan for ${permission.name}`);
    return plan;
  }
}

const registry = (names: string[]): PermissionRegistry => ({ get: (n: string) => (names.includes(n) ? ({ name: n } as PermissionDef) : undefined) }) as unknown as PermissionRegistry;

const INVOICE: RlsResource = { type: 'invoice', table: 'invoices', idColumn: 'id', ancestorTable: 'authz_resource_ancestor', relations: (n) => (n === 'owner' ? { column: 'author_id' } : undefined), mode: true };
const flag = (f: string) => ({ op: 'test.flag', args: { flag: f } });
const owner = { op: 'relation.owner', args: { principals: [] } };

const input = (over: Partial<RlsGenerateInput> = {}): RlsGenerateInput => ({
  models: [model('rbac')],
  permissions: registry(['invoice:read', 'invoice:update', 'invoice:delete']),
  resources: [INVOICE],
  sources: new Map([
    [
      'rbac',
      new Source('rbac', {
        'invoice:read': { kind: 'terms', permit: [flag('green'), owner], deny: [flag("o'black")] },
        'invoice:update': { kind: 'all' },
        'invoice:delete': { kind: 'deny-all', reason: { code: 'role_denied' } },
      }),
    ],
  ]),
  compilers: new Map<string, PlanTermCompiler>([
    ['test.flag', new FlagTerm()],
    ['test.opaque', new OpaqueTerm()],
    ['relation.owner', new RelationOwnerTerm()],
  ]),
  ...over,
});

const OWNER_SQL = `"invoices"."author_id"::text IN (SELECT principal_id FROM (SELECT p->>'type' AS principal_type, p->>'id' AS principal_id FROM jsonb_array_elements(COALESCE(NULLIF(current_setting('spina.principal', true), ''), '[]')::jsonb) AS p) AS sp WHERE principal_type = 'user')`;

describe('generateRls', () => {
  it('enables and forces RLS and writes one policy per command from the plan for any principal', async () => {
    const out = await generateRls(input());
    expect(out.diagnostics).to.deep.equal([]);
    expect(out.up).to.deep.equal([
      'ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY',
      `CREATE POLICY "spina_invoice_read" ON "invoices" FOR SELECT USING ((("invoices"."flag" = 'green') OR (${OWNER_SQL})) AND NOT (("invoices"."flag" = 'o''black')))`,
      'CREATE POLICY "spina_invoice_update" ON "invoices" FOR UPDATE USING (TRUE) WITH CHECK (true)',
      'CREATE POLICY "spina_invoice_delete" ON "invoices" FOR DELETE USING (FALSE)',
      'CREATE POLICY "spina_invoice_insert" ON "invoices" FOR INSERT WITH CHECK (true)',
    ]);
    expect(out.down).to.deep.equal([
      'DROP POLICY IF EXISTS "spina_invoice_read" ON "invoices"',
      'DROP POLICY IF EXISTS "spina_invoice_update" ON "invoices"',
      'DROP POLICY IF EXISTS "spina_invoice_delete" ON "invoices"',
      'DROP POLICY IF EXISTS "spina_invoice_insert" ON "invoices"',
      'ALTER TABLE "invoices" NO FORCE ROW LEVEL SECURITY',
      'ALTER TABLE "invoices" DISABLE ROW LEVEL SECURITY',
    ]);
  });

  it('adds the SYSTEM bypass policy for the configured role only', async () => {
    const out = await generateRls(input({ bypassRole: 'app_system' }));
    expect(out.up).to.include(`CREATE POLICY "spina_invoice_bypass" ON "invoices" FOR ALL TO "app_system" USING (current_setting('spina.bypass', true) = 'on') WITH CHECK (true)`);
    expect(out.down[4]).to.equal('DROP POLICY IF EXISTS "spina_invoice_bypass" ON "invoices"');
  });

  describe('what the database cannot evaluate', () => {
    const opaque = (mode: true | 'partial', read: ModelListPlan) =>
      generateRls(input({ resources: [{ ...INVOICE, mode }], sources: new Map([['rbac', new Source('rbac', { 'invoice:read': read, 'invoice:update': { kind: 'all' }, 'invoice:delete': { kind: 'all' } })]]) }));
    const readPolicy = (up: readonly string[]) => up.find((s) => s.includes('"spina_invoice_read"'));

    it('fails generation with AUTHZ020 under rls: true', async () => {
      const out = await opaque(true, { kind: 'terms', permit: [flag('green'), { op: 'test.opaque', args: {} }], deny: [] });
      expect(out.diagnostics.map((d) => [d.code, d.severity, d.permission])).to.deep.equal([['AUTHZ020', 'error', 'invoice:read']]);
      expect(out.diagnostics[0].message).to.include('term "test.opaque"');
    });

    it("widens an opaque permit member to TRUE under 'partial' and lists it in AUTHZ021", async () => {
      const out = await opaque('partial', { kind: 'terms', permit: [flag('green'), { op: 'test.opaque', args: {} }], deny: [flag('black')] });
      expect(readPolicy(out.up)).to.equal(`CREATE POLICY "spina_invoice_read" ON "invoices" FOR SELECT USING ((TRUE) AND NOT (("invoices"."flag" = 'black')))`);
      expect(out.diagnostics.map((d) => [d.code, d.severity])).to.deep.equal([['AUTHZ021', 'warning']]);
      expect(out.diagnostics[0].message).to.include('widened to TRUE');
    });

    it("drops an opaque exclusion operand under 'partial': the policy only widens", async () => {
      const out = await opaque('partial', { kind: 'terms', permit: [flag('green')], deny: [{ op: 'test.opaque', args: {} }, flag('black')] });
      expect(readPolicy(out.up)).to.equal(`CREATE POLICY "spina_invoice_read" ON "invoices" FOR SELECT USING ((("invoices"."flag" = 'green')) AND NOT (("invoices"."flag" = 'black')))`);
      expect(out.diagnostics[0].message).to.include('dropped from the exclusion');
    });

    it('treats a routed model without an RlsPlanSource as opaque', async () => {
      const strict = await generateRls(input({ models: [model('rbac'), model('abac')] }));
      expect(strict.diagnostics.map((d) => d.code)).to.deep.equal(['AUTHZ020', 'AUTHZ020', 'AUTHZ020']);
      expect(strict.diagnostics[0].message).to.include("model 'abac' (no RlsPlanSource)");
      const partial = await generateRls(input({ models: [model('rbac'), model('abac')], resources: [{ ...INVOICE, mode: 'partial' }] }));
      expect(readPolicy(partial.up)).to.equal(`CREATE POLICY "spina_invoice_read" ON "invoices" FOR SELECT USING ((TRUE) AND NOT (("invoices"."flag" = 'o''black')))`);
    });

    it('ignores a model not routed for the type', async () => {
      const out = await generateRls(input({ models: [model('rbac'), model('abac', ['other'])] }));
      expect(out.diagnostics).to.deep.equal([]);
    });

    it('reports a permission that is not registered', async () => {
      const out = await generateRls(input({ permissions: registry(['invoice:read', 'invoice:update']) }));
      expect(out.diagnostics.map((d) => [d.code, d.permission])).to.deep.equal([['AUTHZ020', 'invoice:delete']]);
      expect(out.up).to.include('CREATE POLICY "spina_invoice_delete" ON "invoices" FOR DELETE USING (FALSE)');
    });
  });

  it('writes a migration that runs the statements up and down', async () => {
    const source = rlsMigrationSource(await generateRls(input()), 'AuthzRls_2026_12_01_00_00_00', 'default');
    expect(source).to.include("@Migration(\"default\")\nexport class AuthzRls_2026_12_01_00_00_00 extends OrmMigration {");
    expect(source).to.include('  "ALTER TABLE \\"invoices\\" ENABLE ROW LEVEL SECURITY",');
    expect(source).to.include('for (const sql of DOWN) await');
  });
});
