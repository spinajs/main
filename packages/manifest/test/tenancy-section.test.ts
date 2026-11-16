import { expect } from 'chai';
import 'mocha';
import { DECLARED_ENTRY_TENANCY, hashManifest, mergeFragments, mountsTenantMiddleware, undeclaredTenancy, validateFragment, validateManifest } from '../src/index.js';
import type { AuthzSection, Manifest, ModelEntry, ModelTenant, TenancyEntryPoint, TenancySection } from '../src/index.js';
import { fragment, src } from './support.js';

const meta = (names: string[]): { app: Manifest['app']; packages: Manifest['packages']; generatedAt: string } => ({
  app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' },
  packages: names.map((name) => ({ name, version: '1.0.0', entry: 'lib/index.js', outDir: 'lib', fragment: `${name}/lib/manifest.fragment.json` })),
  generatedAt: '2026-01-01T00:00:00.000Z',
});

const model = (pkg: string, className: string, tenant?: ModelTenant): ModelEntry => ({
  id: `${pkg}:${className}`, className, tableName: className.toLowerCase(), columns: [], relations: [], ...(tenant ? { tenant } : {}), source: src(pkg),
});

const section = (over: Partial<TenancySection> = {}): TenancySection => ({ models: [], entryPoints: [], escapes: [], ignores: [], ...over });
const authz = (...entryPoints: AuthzSection['entryPoints']): AuthzSection => ({ resources: [], permissions: [], entryPoints, findings: [], ignores: [] });
const route = (id: string, over: Partial<TenancyEntryPoint> = {}): TenancyEntryPoint => ({ kind: 'route', id, tenancy: 'none', source: src(), ...over });

describe('manifest tenancy section', () => {
  it('validates a fragment with a tenancy section and tenant models', () => {
    const tenancy = section({
      models: [{ model: 'app:Invoice', tenant: { isolation: 'schema', column: false, rls: true }, source: src() }],
      entryPoints: [
        route('GET /health'),
        route('GET /invoices/:id', { tenancy: 'required', declared: 'TenantRoute' }),
        route('POST /reports/run', { tenancy: 'all', declared: 'AllTenants', reason: 'monthly revenue report' }),
        { kind: 'schedule', id: 'close-day', tenancy: 'each', declared: 'each', source: src() },
        { kind: 'queue-handler', id: 'job:Recount', tenancy: 'none', declared: 'carry', source: src() },
      ],
      escapes: [{ kind: 'acrossTenants', reason: 'nightly dunning report', model: 'Invoice', source: src() }, { kind: 'runAcrossTenants', source: src() }],
      ignores: [{ code: 'TEN002', reason: 'usage export', source: src() }],
    });
    const models = [model('app', 'Invoice', { isolation: 'schema', column: false, rls: true }), model('app', 'Payment', { column: 'org_id' }), model('app', 'Note', {})];
    expect(validateFragment(fragment('app', { models, tenancy }))).to.deep.equal([]);
  });

  it('rejects an isolation, an entry tenancy or a declaration outside the contract', () => {
    const invalid = (tenancy: unknown): string[] => validateFragment({ ...fragment('app'), tenancy });
    expect(invalid(section())).to.deep.equal([]);
    expect(invalid({ ...section(), models: [{ model: 'app:A', tenant: { isolation: 'database' }, source: src() }] })).to.not.be.empty;
    expect(invalid({ ...section(), entryPoints: [{ ...route('GET /a'), tenancy: 'optional' }] })).to.not.be.empty;
    expect(invalid({ ...section(), entryPoints: [{ ...route('GET /a'), declared: 'Tenant' }] })).to.not.be.empty;
  });

  it('maps what is declared to an entry tenancy, and an entry point that declares nothing to none unless TenantMiddleware is mounted on every route', () => {
    expect(DECLARED_ENTRY_TENANCY).to.deep.equal({ TenantRoute: 'required', NoTenant: 'none', AllTenants: 'all', carry: 'none', required: 'required', none: 'none', each: 'each' });
    const kinds = ['route', 'socket-command', 'socket-event', 'queue-handler', 'schedule', 'cli'] as const;
    expect(kinds.map((kind) => undeclaredTenancy(kind, false))).to.deep.equal(['none', 'none', 'none', 'none', 'none', 'none']);
    expect(kinds.map((kind) => undeclaredTenancy(kind, true))).to.deep.equal(['required', 'none', 'none', 'none', 'none', 'none']);
    expect(mountsTenantMiddleware([{ type: 'RequestId' }, { type: 'TenantMiddleware' }])).to.equal(true);
    expect(mountsTenantMiddleware([{ type: 'RequestId' }])).to.equal(false);
    expect(mountsTenantMiddleware(undefined)).to.equal(false);
  });

  it('has no tenancy section when no fragment declares one, whatever entry points they have', () => {
    const app = fragment('app', { models: [model('app', 'Note')], authz: authz({ kind: 'route', id: 'GET /a', access: [], source: src() }) });
    const merged = mergeFragments(app, [fragment('dep')], meta(['dep', 'app']));
    expect(merged).to.not.have.property('tenancy');
    expect(merged.models[0]).to.not.have.property('tenant');
  });

  it('concatenates the sections, dependencies first, and lists the entry points of a fragment without one as having no scope', () => {
    const dep = fragment('dep', { authz: authz({ kind: 'route', id: 'GET /dep', access: [], source: src('dep') }, { kind: 'schedule', id: 'sweep', access: [], source: src('dep') }) });
    const lib = fragment('lib', { tenancy: section({ escapes: [{ kind: 'runAcrossTenants', reason: 'usage rollup', source: src('lib') }], ignores: [{ code: 'TEN002', reason: 'r', source: src('lib') }] }) });
    const app = fragment('app', { tenancy: section({ models: [{ model: 'app:Invoice', tenant: {}, source: src() }], entryPoints: [route('GET /mine', { tenancy: 'required', declared: 'TenantRoute' })] }) });
    const { tenancy } = mergeFragments(app, [dep, lib], meta(['dep', 'lib', 'app']));
    expect(tenancy?.entryPoints).to.deep.equal([
      { kind: 'route', id: 'GET /dep', tenancy: 'none', source: src('dep') },
      { kind: 'schedule', id: 'sweep', tenancy: 'none', source: src('dep') },
      route('GET /mine', { tenancy: 'required', declared: 'TenantRoute' }),
    ]);
    expect(tenancy?.models.map((m) => m.model)).to.deep.equal(['app:Invoice']);
    expect(tenancy?.escapes.map((e) => e.source.package)).to.deep.equal(['lib']);
    expect(tenancy?.ignores.map((i) => i.code)).to.deep.equal(['TEN002']);
  });

  it('requires a tenant on every route that declares nothing when TenantMiddleware is mounted on every route, and then has a section even when no package declares one', () => {
    const dep = fragment('dep', { authz: authz({ kind: 'route', id: 'GET /dep', access: [], source: src('dep') }, { kind: 'socket-command', id: 'chat.send', access: [], source: src('dep') }) });
    const app = fragment('app', { tenancy: section({ entryPoints: [route('GET /a'), route('GET /status', { declared: 'NoTenant' }), { kind: 'schedule', id: 'sweep', tenancy: 'none', source: src() }] }) });
    const mounted = { ...meta(['dep', 'app']), globalRouteMiddlewares: [{ type: 'RequestId' }, { type: 'TenantMiddleware' }] };
    const scopes = (m: Manifest): Array<[string, string]> => (m.tenancy?.entryPoints ?? []).map((e) => [e.id, e.tenancy]);
    expect(scopes(mergeFragments(app, [dep], mounted))).to.deep.equal([['GET /dep', 'required'], ['chat.send', 'none'], ['GET /a', 'required'], ['GET /status', 'none'], ['sweep', 'none']]);
    expect(scopes(mergeFragments(app, [dep], meta(['dep', 'app'])))).to.deep.equal([['GET /dep', 'none'], ['chat.send', 'none'], ['GET /a', 'none'], ['GET /status', 'none'], ['sweep', 'none']]);
    expect(mergeFragments(fragment('app'), [dep], mounted).tenancy).to.deep.equal({
      models: [],
      entryPoints: [{ kind: 'route', id: 'GET /dep', tenancy: 'required', source: src('dep') }, { kind: 'socket-command', id: 'chat.send', tenancy: 'none', source: src('dep') }],
      escapes: [],
      ignores: [],
    });
  });

  it('marks a dependency model a tenant model when another package registers it, and keeps what the model itself states', () => {
    const dep = fragment('dep', { models: [model('dep', 'JobModel'), model('dep', 'Own', { isolation: 'schema' }), model('dep', 'Other')] });
    const registered = [{ model: 'dep:JobModel', tenant: { rls: true }, source: src() }, { model: 'dep:Own', tenant: { isolation: 'row' as const }, source: src() }];
    const merged = mergeFragments(fragment('app', { tenancy: section({ models: registered }) }), [dep], meta(['dep', 'app']));
    expect(merged.models.map((m) => [m.id, m.tenant])).to.deep.equal([['dep:JobModel', { rls: true }], ['dep:Own', { isolation: 'schema' }], ['dep:Other', undefined]]);
    expect(validateManifest(merged)).to.deep.equal([]);
  });

  it('covers the tenancy section in the hash', () => {
    const build = (reason: string): Manifest => mergeFragments(fragment('app', { tenancy: section({ escapes: [{ kind: 'runAcrossTenants', reason, source: src() }] }) }), [], meta(['app']));
    expect(hashManifest(build('usage rollup'))).to.not.equal(hashManifest(build('billing export')));
  });
});
