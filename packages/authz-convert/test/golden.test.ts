import { PermissionRegistryImpl } from '@spinajs/authz';
import { compileGrants, compileRoles } from '@spinajs/authz-rbac';
import type { GrantDef, RoleDef } from '@spinajs/authz-rbac';
import { expect } from 'chai';
import * as fs from 'node:fs';
import { join } from 'node:path';

import { convertLayers, loadLayers, readDbFacts, scanSources } from '../src/index.js';
import type { ConvertOptions, ConvertResult } from '../src/index.js';

// UPDATE_GOLDEN=1 rewrites the expected files; review the diff before committing it.
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const ROOT = 'test/fixtures/golden';

interface Case {
  readonly name: string;
  readonly options: () => Omit<ConvertOptions, 'dirs'>;
}

const CASES: readonly Case[] = [
  // @spinajs/rbac and @spinajs/rbac-http-user 2.0.546 defaults (rbac/src/config/rbac.ts, rbac-http-user/src/config/rbac-http.ts)
  { name: 'default-2.0.546', options: () => ({}) },
  // the shapes of a production app's config, with the DB rows and model sources the converter can read
  { name: 'acme-backend', options: () => ({ db: readDbFacts(`${ROOT}/acme-backend/db.json`), src: scanSources(`${ROOT}/acme-backend/src`) }) },
];

const unix = (s: string) => s.replace(/\r\n/g, '\n');
const read = (text: string): any => new Function(`return ${text.replace(/^\/\/.*$/gm, '').replace('export default', '').trim().replace(/;$/, '')};`)();

describe('golden conversions', () => {
  const env = { NODE_ENV: process.env.NODE_ENV, ACME: process.env.ACME_TWO_FACTOR_AUTH };
  const results = new Map<string, ConvertResult>();

  before(async () => {
    // Config files compute values from these at load time.
    process.env.NODE_ENV = 'test';
    delete process.env.ACME_TWO_FACTOR_AUTH;
    for (const c of CASES) {
      const dir = `${ROOT}/${c.name}/config`;
      results.set(c.name, convertLayers(await loadLayers([dir]), { dirs: [dir], ...c.options() }));
    }
  });

  after(() => {
    if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env.NODE_ENV;
    if (env.ACME !== undefined) process.env.ACME_TWO_FACTOR_AUTH = env.ACME;
  });

  for (const c of CASES) {
    describe(c.name, () => {
      const expectedDir = join(ROOT, c.name, 'expected');

      it('writes the expected files', () => {
        const r = results.get(c.name)!;
        if (UPDATE) {
          fs.rmSync(expectedDir, { recursive: true, force: true });
          fs.mkdirSync(expectedDir, { recursive: true });
          for (const f of r.files) fs.writeFileSync(join(expectedDir, f.name), f.content);
        }
        expect(r.files.map((f) => f.name).sort()).to.deep.equal(fs.readdirSync(expectedDir).sort());
        for (const f of r.files) expect(unix(f.content), f.name).to.equal(unix(fs.readFileSync(join(expectedDir, f.name), 'utf-8')));
      });

      it('writes roles and permissions the 3.0 RBAC compiler accepts', () => {
        const r = results.get(c.name)!;
        const authz = read(r.files.find((f) => f.name === 'authz-generated.ts')!.content).authz;
        const registry = new PermissionRegistryImpl();
        registry.register(
          Object.entries(authz.permissions as Record<string, { fields?: boolean }>).map(([name, d]) => ({ name, ...d })),
          'converted',
        );
        registry.freeze();
        const roles: RoleDef[] = Object.entries(authz.rbac.roles as Record<string, any>).map(([name, d]) => ({
          name,
          extends: d.extends ?? [],
          grants: (d.grants as (string | GrantDef)[]).map((g) => (typeof g === 'string' ? { permission: g } : g)),
          assignable: d.assignable ?? true,
          source: 'converted',
        }));
        const defined = new Set(roles.map((x) => x.name));
        // Roles a 3.0 package fragment defines (admin.users, …) stand in empty.
        for (const name of new Set(roles.flatMap((x) => x.extends))) if (!defined.has(name)) roles.push({ name, extends: [], grants: [], assignable: true, source: 'package' });
        const index = compileGrants(compileRoles(roles), registry);
        expect(index.unmatchedGlobs).to.deep.equal([]);
        expect(index.droppedFields).to.deep.equal([]);
      });
    });
  }

  it('reproduces the 2.x scope of design §18.3 (a) on the anonymised back-office role', () => {
    const authz = read(results.get('acme-backend')!.files.find((f) => f.name === 'authz-generated.ts')!.content).authz;
    const role = authz.rbac.roles['partner.backoffice'];
    expect(role.extends).to.deep.equal(['user', 'route.home', 'route.salesman', 'route.campaigns', 'localisations.read', 'location.subscriptions']);
    expect(role.grants.slice(0, 8)).to.deep.equal(
      ['CampaignView', 'Campaign'].flatMap((res) => ['create', 'read', 'update', 'delete'].map((v) => ({ permission: `${res}:${v}`, relation: 'partner' }))),
    );
    expect(role.grants).to.include('Client:create');
  });
});
