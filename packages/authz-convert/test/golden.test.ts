import { AUTHZ_CONFIGURATION_SCHEMA, PermissionRegistryImpl } from '@spinajs/authz';
import Ajv from 'ajv';
import { pathToFileURL } from 'node:url';
import { compileGrants, compileRoles } from '@spinajs/authz-rbac';
import type { GrantDef, RoleDef } from '@spinajs/authz-rbac';
import { expect } from 'chai';
import * as fs from 'node:fs';
import { join } from 'node:path';
import _ from 'lodash';

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

      it('writes authz and authn config the 3.0 schemas accept', async () => {
        // Read from the built authn package by path: authz* packages may not depend on authn* (plan §1 rule 10).
        const authnSchema = (await import(pathToFileURL(join(process.cwd(), '..', 'authn', 'lib', 'mjs', 'schemas', 'authn.configuration.js')).href)).AUTHN_CONFIGURATION_SCHEMA;
        // ajv is CommonJS; under ESM its class may sit on .default.
        const AjvClass = ((Ajv as unknown as { default?: unknown }).default ?? Ajv) as new (options: object) => { compile(schema: object): ((data: unknown) => boolean) & { errors?: unknown }; errorsText(errors?: unknown): string };
        const ajv = new AjvClass({ allErrors: true, strict: false, useDefaults: true, $data: true });
        const validate = { authz: ajv.compile(AUTHZ_CONFIGURATION_SCHEMA), authn: ajv.compile(authnSchema) };
        const r = results.get(c.name)!;
        const handDone = r.findings.some((x) => x.code === 'guard-privileged-permission');
        for (const f of r.files) {
          const root = f.name.split('-')[0] as 'authz' | 'authn';
          if (!f.name.endsWith('.ts') || !(root in validate)) continue;
          // An env file is loaded over the common one, so it is validated as the app sees it, merged.
          const common = r.files.find((x) => x.name === `${root}-generated.ts`);
          const value = _.merge({}, common && common !== f ? read(common.content)[root] : {}, structuredClone(read(f.content)[root]));
          // The finding leaves privilegedPermission to a person; give it one, as they would.
          if (root === 'authz' && handDone) value.admin.guard.privilegedPermission = 'users:update';
          expect(validate[root](value), `${f.name}: ${ajv.errorsText(validate[root].errors)}`).to.equal(true);
        }
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
