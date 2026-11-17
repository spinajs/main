import { expect } from 'chai';
import 'mocha';
import { diffManifest, renderMarkdown } from '../src/index.js';
import type { AuthzSection, Change, Manifest, ModelTenant, TenancyEntryPoint, TenancyEscape, TenancyModel, TenancySection } from '../src/index.js';
import { manifestWith, src } from './support.js';

const withTenancy = (over: Partial<TenancySection>): Manifest => manifestWith({ tenancy: { models: [], entryPoints: [], escapes: [], ignores: [], ...over } });
const rows = (base: Manifest, head: Manifest): Change[] => diffManifest(base, head).changes.filter((c) => c.section === 'tenancy');
const tenant = (model: string, state: ModelTenant = {}): TenancyModel => ({ model, tenant: state, source: src() });
const route = (id: string, over: Partial<TenancyEntryPoint> = {}): TenancyEntryPoint => ({ kind: 'route', id, tenancy: 'none', source: src(), ...over });
const routes = (...ids: string[]): AuthzSection => ({ resources: [], permissions: [], entryPoints: ids.map((id) => ({ kind: 'route' as const, id, access: [], source: src() })), findings: [], ignores: [] });
const escape = (reason: string | undefined, over: Partial<TenancyEscape> = {}): TenancyEscape => ({ kind: 'acrossTenants', ...(reason === undefined ? {} : { reason }), model: 'Invoice', source: src(), ...over });

describe('diffManifest tenancy', () => {
  it('reports nothing without a section or for the same one', () => {
    const same = { models: [tenant('app:Invoice')], entryPoints: [route('GET /a')], escapes: [escape('nightly dunning report')] };
    expect(rows(manifestWith(), manifestWith())).to.deep.equal([]);
    expect(rows(withTenancy(same), withTenancy(same))).to.deep.equal([]);
  });

  it('reports a model that becomes or stops being a tenant model, and a changed isolation, column or RLS', () => {
    const base = withTenancy({ models: [tenant('app:Invoice'), tenant('app:Ledger', { isolation: 'row', column: 'tenant_id' }), tenant('app:Note')] });
    const head = withTenancy({ models: [tenant('app:Invoice'), tenant('app:Ledger', { isolation: 'schema', column: false, rls: true }), tenant('app:Payment', { column: 'org_id' })] });
    expect(rows(base, head)).to.deep.equal([
      { section: 'tenancy', kind: 'changed', id: 'model app:Ledger', breaking: false, detail: 'isolation changed from row to schema; column changed from tenant_id to none; rls changed from default to on' },
      { section: 'tenancy', kind: 'removed', id: 'model app:Note', breaking: false, detail: 'no longer a tenant model: its rows are not confined to a tenant' },
      { section: 'tenancy', kind: 'added', id: 'model app:Payment', breaking: false, detail: 'now a tenant model (isolation default, column org_id, rls default)' },
    ]);
  });

  it('reports an entry point whose tenancy changed; only a route that now requires a tenant is breaking', () => {
    const base = withTenancy({
      entryPoints: [
        route('GET /a', { tenancy: 'none', declared: 'NoTenant' }),
        route('GET /b'),
        route('GET /c', { tenancy: 'all', declared: 'AllTenants', reason: 'old' }),
        { kind: 'schedule', id: 'close-day', tenancy: 'none', source: src() },
        route('GET /gone', { tenancy: 'none', declared: 'NoTenant' }),
      ],
    });
    const head = withTenancy({
      entryPoints: [
        route('GET /a', { tenancy: 'required', declared: 'TenantRoute' }),
        route('GET /b', { tenancy: 'all', declared: 'AllTenants', reason: 'operator console' }),
        route('GET /c', { tenancy: 'all', declared: 'AllTenants', reason: 'new' }),
        { kind: 'schedule', id: 'close-day', tenancy: 'each', declared: 'each', source: src() },
        route('GET /new', { tenancy: 'none', declared: 'NoTenant' }),
        route('GET /plain'),
      ],
    });
    expect(rows(base, head)).to.deep.equal([
      { section: 'tenancy', kind: 'changed', id: 'route GET /a', breaking: true, detail: 'tenancy changed from none to required' },
      { section: 'tenancy', kind: 'changed', id: 'route GET /b', breaking: false, detail: 'tenancy changed from none to all (operator console)' },
      { section: 'tenancy', kind: 'changed', id: 'route GET /c', breaking: false, detail: 'tenancy changed from all (old) to all (new)' },
      { section: 'tenancy', kind: 'added', id: 'route GET /new', breaking: false, detail: 'declares tenancy none' },
      { section: 'tenancy', kind: 'changed', id: 'schedule close-day', breaking: false, detail: 'tenancy changed from none to each' },
    ]);
    expect(diffManifest(base, head).breaking).to.equal(true);
  });

  it('breaks only for a route that now requires a tenant, from all as well, and never for a queue handler', () => {
    const job = (tenancy: TenancyEntryPoint['tenancy']): TenancyEntryPoint => ({ kind: 'queue-handler', id: 'job:Sync', tenancy, declared: tenancy === 'required' ? 'required' : 'carry', source: src() });
    const base = withTenancy({ entryPoints: [route('GET /ops', { tenancy: 'all', declared: 'AllTenants', reason: 'ops' }), job('none')] });
    const head = withTenancy({ entryPoints: [route('GET /ops', { tenancy: 'required', declared: 'TenantRoute' }), job('required')] });
    expect(rows(base, head)).to.deep.equal([
      { section: 'tenancy', kind: 'changed', id: 'queue-handler job:Sync', breaking: false, detail: 'tenancy changed from none to required' },
      { section: 'tenancy', kind: 'changed', id: 'route GET /ops', breaking: true, detail: 'tenancy changed from all (ops) to required' },
    ]);
  });

  it('keeps the entry points of two packages that share an id apart', () => {
    const job = (pkg: string, tenancy: TenancyEntryPoint['tenancy']): TenancyEntryPoint => ({ kind: 'queue-handler', id: 'job:Recount', tenancy, declared: tenancy === 'required' ? 'required' : 'none', source: src(pkg) });
    const base = withTenancy({ entryPoints: [job('dep', 'none'), job('app', 'required')] });
    expect(rows(base, withTenancy({ entryPoints: [job('dep', 'none'), job('app', 'required')] }))).to.deep.equal([]);
    expect(rows(base, withTenancy({ entryPoints: [job('dep', 'required'), job('app', 'required')] }))).to.deep.equal([
      { section: 'tenancy', kind: 'changed', id: 'queue-handler job:Recount', breaking: false, detail: 'tenancy changed from none to required' },
    ]);
  });

  it('compares a manifest without a section as one whose entry points have no scope', () => {
    const before = manifestWith({ authz: routes('GET /a', 'GET /b') });
    const after = manifestWith({ authz: routes('GET /a', 'GET /b'), tenancy: { models: [], entryPoints: [route('GET /a', { tenancy: 'required' }), route('GET /b', { declared: 'NoTenant' })], escapes: [], ignores: [] } });
    expect(rows(before, after)).to.deep.equal([{ section: 'tenancy', kind: 'changed', id: 'route GET /a', breaking: true, detail: 'tenancy changed from none to required' }]);
    expect(rows(after, before)).to.deep.equal([{ section: 'tenancy', kind: 'changed', id: 'route GET /a', breaking: false, detail: 'tenancy changed from required to none' }]);
  });

  it('shows an all scope whose reason is no string literal as such', () => {
    const head = withTenancy({ entryPoints: [route('POST /export', { tenancy: 'all', declared: 'AllTenants' })] });
    expect(rows(manifestWith(), head)).to.deep.equal([{ section: 'tenancy', kind: 'added', id: 'route POST /export', breaking: false, detail: 'declares tenancy all (no literal reason)' }]);
  });

  it('reports an escape added or removed with its reason, by file, model and reason and not by line', () => {
    const base = withTenancy({ escapes: [escape('nightly dunning report'), escape('old export', { model: 'Payment' })] });
    const head = withTenancy({
      escapes: [
        escape('nightly dunning report', { source: { ...src(), line: 40 } }),
        { kind: 'runAcrossTenants', reason: 'usage rollup', source: src() },
        escape(undefined),
        escape(undefined, { source: { ...src(), line: 9 } }),
      ],
    });
    expect(rows(base, head)).to.deep.equal([
      { section: 'tenancy', kind: 'added', id: 'acrossTenants app:src/x.ts on Invoice', breaking: false, detail: 'no literal reason (2 call sites)' },
      { section: 'tenancy', kind: 'removed', id: 'acrossTenants app:src/x.ts on Payment', breaking: false, detail: 'reason: old export' },
      { section: 'tenancy', kind: 'added', id: 'runAcrossTenants app:src/x.ts', breaking: false, detail: 'reason: usage rollup' },
    ]);
    expect(diffManifest(base, head).breaking).to.equal(false);
  });

  it('renders the section last, as a table like the others', () => {
    const md = renderMarkdown(diffManifest(manifestWith(), withTenancy({ escapes: [escape('nightly dunning report')] })));
    expect(md).to.include('Result: non-breaking (1 changes)');
    expect(md).to.include('### tenancy\n\n| Change | Id | Breaking | Detail |\n| --- | --- | --- | --- |\n| added | `acrossTenants app:src/x.ts on Invoice` | no | reason: nightly dunning report |\n');
  });
});
