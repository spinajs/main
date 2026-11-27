import 'mocha';
import { expect } from 'chai';
import { InvalidArgument } from '@spinajs/exceptions';

import { generateTenantRls, tenantRlsStatements } from '../src/index.js';

const INVOICE = { table: 'invoice', column: 'tenant_id', connection: 'default' };
const OWN = `"invoice"."tenant_id" = NULLIF(current_setting('spina.tenant', true), '')`;
const ALONE = `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = '"invoice"'::regclass AND p.polpermissive AND p.polname <> 'spina_tenant_open')`;

describe('tenant row level security statements', () => {
  it('forces row level security with one restrictive policy and a fallback permissive one', () => {
    expect(tenantRlsStatements(INVOICE).up).to.deep.eq([
      'ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY',
      'ALTER TABLE "invoice" FORCE ROW LEVEL SECURITY',
      'DROP POLICY IF EXISTS "spina_tenant_open" ON "invoice"',
      'DROP POLICY IF EXISTS "spina_tenant_isolation" ON "invoice"',
      `CREATE POLICY "spina_tenant_isolation" ON "invoice" AS RESTRICTIVE FOR ALL USING (${OWN}) WITH CHECK (${OWN})`,
      `CREATE POLICY "spina_tenant_open" ON "invoice" AS PERMISSIVE FOR ALL USING (${ALONE}) WITH CHECK (${ALONE})`,
    ]);
  });

  it('lets the all-tenants scope through for members of the bypass role only', () => {
    const both = `(${OWN} OR (current_setting('spina.tenant_all', true) = 'on' AND pg_has_role('app_ops', 'MEMBER')))`;
    expect(tenantRlsStatements(INVOICE, { bypassRole: 'app_ops' }).up[4]).to.eq(`CREATE POLICY "spina_tenant_isolation" ON "invoice" AS RESTRICTIVE FOR ALL USING (${both}) WITH CHECK (${both})`);
  });

  it('drops its own policies and turns row level security off only when no policy is left', () => {
    expect(tenantRlsStatements(INVOICE).down).to.deep.eq([
      'DROP POLICY IF EXISTS "spina_tenant_open" ON "invoice"',
      'DROP POLICY IF EXISTS "spina_tenant_isolation" ON "invoice"',
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = '"invoice"'::regclass) THEN ALTER TABLE "invoice" NO FORCE ROW LEVEL SECURITY; ALTER TABLE "invoice" DISABLE ROW LEVEL SECURITY; END IF; END $$`,
    ]);
  });

  it('quotes names and the role', () => {
    const out = tenantRlsStatements({ table: 'odd"name', column: 'org"id', connection: 'default' }, { bypassRole: "o'brien" });
    expect(out.up[0]).to.eq('ALTER TABLE "odd""name" ENABLE ROW LEVEL SECURITY');
    expect(out.up[4]).to.include('"odd""name"."org""id"').and.include("pg_has_role('o''brien', 'MEMBER')");
    expect(out.up[5]).to.include(`'"odd""name"'::regclass`);
  });

  it('refuses a table name with a dollar sign and an empty column', () => {
    expect(() => tenantRlsStatements({ table: 'a$$b', column: 'tenant_id', connection: 'default' })).to.throw(InvalidArgument, '"a$$b"');
    expect(() => tenantRlsStatements({ table: 'invoice', column: '', connection: 'default' })).to.throw(InvalidArgument, 'column ""');
  });

  it('writes up in table order and down in reverse', () => {
    const out = generateTenantRls([INVOICE, { table: 'note', column: 'org', connection: 'default' }]);
    expect(out.up.filter((s) => s.endsWith('ENABLE ROW LEVEL SECURITY'))).to.deep.eq(['ALTER TABLE "invoice" ENABLE ROW LEVEL SECURITY', 'ALTER TABLE "note" ENABLE ROW LEVEL SECURITY']);
    expect(out.down[0]).to.eq('DROP POLICY IF EXISTS "spina_tenant_open" ON "note"');
    expect(out.down[5]).to.include(`'"invoice"'::regclass`);
  });
});
