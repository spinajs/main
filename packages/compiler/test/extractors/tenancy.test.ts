import { expect } from 'chai';
import { mergeFragments, type ControllerEntry, type Manifest, type ManifestFragment, type MiddlewareRef, type RouteEntry } from '@spinajs/manifest';
import type ts from 'typescript';
import { analyzePackage, createContext, createProgramFromTsconfig } from '../../src/index.js';
import { escapesIn } from '../../src/extractors/tenancy-escapes.js';
import { tenantModelsOf } from '../../src/extractors/tenant-models.js';
import { tenancySectionOf } from '../../src/extractors/tenancy.js';

const analyzed = new Map<string, Promise<ManifestFragment>>();

function fixture(name: string): Promise<ManifestFragment> {
  let fragment = analyzed.get(name);
  if (!fragment) {
    fragment = analyzePackage({ tsconfig: `test/fixtures/${name}/tsconfig.json`, packageRoot: `test/fixtures/${name}` });
    analyzed.set(name, fragment);
  }
  return fragment;
}

describe('tenant models', () => {
  let fragment: ManifestFragment;
  before(async () => {
    fragment = await fixture('tenancy-pkg');
  });

  it('marks a model by its own @Tenant, its nearest tenant base class, a literal registerTenantModel call or the fragment of a dependency', () => {
    expect(fragment.models.map((m) => [m.className, m.tenant])).to.deep.equal([
      ['Fake', undefined],
      ['Ledger', { isolation: 'schema', column: false }],
      ['Invoice', {}],
      ['Payment', { column: 'org_id', rls: true }],
      ['Country', undefined],
      ['Audit', { isolation: 'row' }],
      ['Receipt', { column: 'org_id' }],
      ['Branch', { column: 'branch_id' }],
      ['Vault', { isolation: 'schema' }],
      ['Note', { rls: false }],
    ]);
  });

  it('gives no member to a model whose decorator of the same name another package declares', () => {
    expect(fragment.models.find((m) => m.className === 'Fake')).to.not.have.property('tenant');
    expect(fragment.models.find((m) => m.className === 'Country')).to.not.have.property('tenant');
  });

  it('gives no model of a package without tenancy the member', async () => {
    const plain = await fixture('authz-pkg');
    expect(plain.models).to.have.length(3);
    expect(plain.models.filter((m) => 'tenant' in m)).to.deep.equal([]);
  });
});

describe('tenancy entry points', () => {
  let fragment: ManifestFragment;
  let tenancy: NonNullable<ManifestFragment['tenancy']>;
  before(async () => {
    fragment = await fixture('tenancy-pkg');
    tenancy = fragment.tenancy!;
  });

  const entry = (id: string) => tenancy.entryPoints.find((e) => e.id === id);

  it('lists the tenant models of the package with where each is declared, then a model of another package it registers', () => {
    expect(tenancy.models.map((m) => [m.model, m.tenant, m.source.line])).to.deep.equal([
      ['tenancy-pkg:Ledger', { isolation: 'schema', column: false }, 6],
      ['tenancy-pkg:Invoice', {}, 14],
      ['tenancy-pkg:Payment', { column: 'org_id', rls: true }, 22],
      ['tenancy-pkg:Audit', { isolation: 'row' }, 43],
      ['tenancy-pkg:Receipt', { column: 'org_id' }, 40],
      ['tenancy-pkg:Branch', { column: 'branch_id' }, 7],
      ['tenancy-pkg:Vault', { isolation: 'schema' }, 13],
      ['tenancy-pkg:Note', { rls: false }, 24],
      ['@spinajs/queue:JobModel', {}, 44],
    ]);
    expect(tenancy.models.map((m) => m.model), 'a registered class of the package that is no model').to.not.include('tenancy-pkg:Stamped');
  });

  it('reads @Tenant and registerTenantModel under an import alias and a namespace import, and skips a local registerTenantModel', () => {
    expect(tenancy.models.filter((m) => m.source.file === 'src/resolved.ts').map((m) => m.model)).to.deep.equal(['tenancy-pkg:Branch', 'tenancy-pkg:Vault', 'tenancy-pkg:Note']);
    expect(tenancy.models.map((m) => m.model)).to.not.include('tenancy-pkg:Country');
  });

  it('reads TenantRoute, NoTenant and AllTenants on a route, under an import alias too', () => {
    expect(entry('GET /invoices/mine')).to.deep.include({ kind: 'route', tenancy: 'required', declared: 'TenantRoute' });
    expect(entry('GET /invoices/aliased')).to.deep.include({ tenancy: 'required', declared: 'TenantRoute' });
    expect(entry('GET /invoices/status')).to.deep.include({ tenancy: 'none', declared: 'NoTenant' });
    expect(entry('POST /invoices/report')).to.deep.include({ tenancy: 'all', declared: 'AllTenants', reason: 'monthly revenue report' });
  });

  it('reads the route decorators through a namespace import', () => {
    expect(entry('GET /resolved/scoped')).to.deep.include({ tenancy: 'required', declared: 'TenantRoute' });
    expect(entry('GET /resolved/all')).to.deep.include({ tenancy: 'all', declared: 'AllTenants', reason: 'namespace import' });
  });

  it('records an @AllTenants reason that is no string literal as missing', () => {
    expect(entry('POST /invoices/dynamic')).to.deep.include({ tenancy: 'all', declared: 'AllTenants' });
    expect(entry('POST /invoices/dynamic')).to.not.have.property('reason');
  });

  it('takes the nearest class of the controller chain when the route declares nothing; the route wins, also when a base class declares it', () => {
    expect(entry('GET /admin/tenants')).to.deep.include({ tenancy: 'all', declared: 'AllTenants', reason: 'operator console' });
    expect(entry('GET /admin/me')).to.deep.include({ tenancy: 'required', declared: 'TenantRoute' });
    expect(entry('GET /admin/me')).to.not.have.property('reason');
    expect(entry('GET /admin/health')).to.deep.include({ tenancy: 'none', declared: 'NoTenant' });
  });

  it('stops at a closer hand-written TenantMiddleware mount, which declares nothing, before a class-level decorator', () => {
    expect(entry('GET /guarded/open')).to.deep.include({ tenancy: 'none' });
    expect(entry('GET /guarded/open')).to.not.have.property('declared');
    expect(entry('GET /guarded/scoped')).to.deep.include({ tenancy: 'required', declared: 'TenantRoute' });
  });

  it('gives an entry point that declares nothing no scope, whatever its kind', () => {
    const undeclared = [
      ['GET /invoices/:id', 'route'],
      ['GET /lookalike/open', 'route'],
      ['GET /lookalike/scoped', 'route'],
      ['GET /lookalike/all', 'route'],
      ['GET /ops/ping', 'route'],
      ['GET /ops/stats', 'route'],
      ['billing.totals', 'socket-command'],
      ['job:Notify', 'queue-handler'],
      ['heartbeat', 'schedule'],
      ['billing:sync', 'cli'],
    ];
    for (const [id, kind] of undeclared) {
      expect(entry(id), id).to.deep.include({ kind, tenancy: 'none' });
      expect(entry(id), id).to.not.have.property('declared');
    }
  });

  it('records the TenantMiddleware the three decorators mount among the middlewares of the route, with the decorator arguments', () => {
    const routes = fragment.controllers.find((c) => c.className === 'InvoicesController')!.routes;
    const mounted = (handler: string) => routes.find((r) => r.handler === handler)!.middlewares;
    expect(mounted('mine')).to.deep.equal([{ type: 'TenantMiddleware', decoratorArgs: [] }]);
    expect(mounted('aliased')).to.deep.equal([{ type: 'TenantMiddleware', decoratorArgs: [] }]);
    expect(mounted('status')).to.deep.equal([{ type: 'TenantMiddleware', decoratorArgs: [] }]);
    expect(mounted('report')).to.deep.equal([{ type: 'TenantMiddleware', decoratorArgs: ['monthly revenue report'] }]);
    expect(mounted('dynamic')).to.deep.equal([{ type: 'TenantMiddleware' }]);
    expect(mounted('get')).to.deep.equal([]);
    expect(fragment.controllers.find((c) => c.className === 'LookalikeController')!.routes.flatMap((r) => r.middlewares)).to.deep.equal([]);
  });

  it('maps the tenancy option of @Job and @Schedule', () => {
    expect(entry('job:SendInvoice')).to.deep.include({ kind: 'queue-handler', tenancy: 'required', declared: 'required' });
    expect(entry('job:Recount')).to.deep.include({ tenancy: 'none', declared: 'carry' });
    expect(entry('job:Purge')).to.deep.include({ tenancy: 'none', declared: 'none' });
    expect(entry('close-day')).to.deep.include({ kind: 'schedule', tenancy: 'each', declared: 'each' });
    expect(entry('vacuum')).to.deep.include({ tenancy: 'none', declared: 'none' });
  });

  it('lists every entry point of the package under the kind, id and source the authz section gives it', () => {
    const key = (e: { kind: string; id: string; source: { file: string; line: number } }): string => `${e.kind} ${e.id} ${e.source.file}:${e.source.line}`;
    expect(tenancy.entryPoints.map(key)).to.deep.equal(fragment.authz!.entryPoints.map(key));
    expect(tenancy.entryPoints).to.have.length(27);
  });

  it('writes no section for a package that declares no tenancy', async () => {
    const plain = await fixture('authz-pkg');
    expect(plain.authz?.entryPoints).to.not.be.empty;
    expect(plain).to.not.have.property('tenancy');
  });
});

describe('tenancy entry points under the global TenantMiddleware mount', () => {
  let fragment: ManifestFragment;
  let merged: Manifest;
  before(async () => {
    fragment = await fixture('tenancy-pkg');
    const app = { name: 'tenancy-pkg', version: '1.0.0', root: '.', outDir: fragment.package.outDir };
    merged = mergeFragments(fragment, [], { app, packages: [], generatedAt: '2026-11-17T00:00:00.000Z', globalRouteMiddlewares: [{ type: 'TenantMiddleware' }] });
  });

  const scope = (id: string): string | undefined => merged.tenancy!.entryPoints.find((e) => e.id === id)?.tenancy;

  it('pairs every route whose nearest TenantMiddleware mount a decorator made with a declared entry, which the merge keeps', () => {
    // The route's own mounts come before its controller's. A hand-written @Middleware(TenantMiddleware, ...) records `options`; a decorator does not.
    const nearest = (c: ControllerEntry, r: RouteEntry): MiddlewareRef | undefined => [...r.middlewares, ...c.middlewares].find((m) => m.type === 'TenantMiddleware');
    const byDecorator = (m: MiddlewareRef | undefined): boolean => m !== undefined && !('options' in m);
    const mounting = fragment.controllers.flatMap((c) => c.routes.filter((r) => byDecorator(nearest(c, r))));
    const ids = mounting.map((r) => `${r.method.toUpperCase()} ${r.fullPath}`);
    expect(ids).to.have.members(['GET /invoices/mine', 'GET /invoices/aliased', 'GET /invoices/status', 'POST /invoices/report', 'POST /invoices/dynamic', 'GET /admin/tenants', 'GET /admin/me', 'GET /admin/health', 'GET /guarded/scoped', 'GET /resolved/scoped', 'GET /resolved/all']);
    expect(ids.map((id) => fragment.tenancy!.entryPoints.find((e) => e.id === id)?.declared)).to.not.include(undefined);
    expect(ids.map((id) => [id, scope(id)])).to.have.deep.members([
      ['GET /invoices/mine', 'required'],
      ['GET /invoices/aliased', 'required'],
      ['GET /invoices/status', 'none'],
      ['POST /invoices/report', 'all'],
      ['POST /invoices/dynamic', 'all'],
      ['GET /admin/tenants', 'all'],
      ['GET /admin/me', 'required'],
      ['GET /admin/health', 'none'],
      ['GET /guarded/scoped', 'required'],
      ['GET /resolved/scoped', 'required'],
      ['GET /resolved/all', 'all'],
    ]);
  });

  it('requires a tenant on a plain undeclared route and keeps one with a closer hand-written TenantMiddleware mount at none', () => {
    expect(fragment.controllers.find((c) => c.className === 'OpsController')!.middlewares).to.deep.equal([{ type: 'TenantMiddleware', options: [{ tenancy: 'none' }] }]);
    expect(['GET /invoices/:id', 'GET /lookalike/open', 'GET /ops/ping', 'GET /ops/stats', 'GET /guarded/open'].map(scope)).to.deep.equal(['required', 'required', 'none', 'none', 'none']);
  });
});

describe('tenancy escapes and ignores', () => {
  let tenancy: NonNullable<ManifestFragment['tenancy']>;
  before(async () => {
    tenancy = (await fixture('tenancy-pkg')).tenancy!;
  });

  it('lists every acrossTenants and runAcrossTenants call with its literal reason and the model of the builder, through an alias and a namespace import too', () => {
    expect(tenancy.escapes.map((e) => [e.kind, e.reason, e.model])).to.deep.equal([
      ['acrossTenants', 'nightly dunning report', 'Invoice'],
      ['acrossTenants', undefined, 'Payment'],
      ['runAcrossTenants', 'usage rollup', undefined],
      ['runAcrossTenants', 'an alias still counts', undefined],
      ['runAcrossTenants', 'plain template', undefined],
      ['runAcrossTenants', undefined, undefined],
      ['runAcrossTenants', undefined, undefined],
      ['runAcrossTenants', undefined, undefined],
      ['runAcrossTenants', undefined, undefined],
      ['runAcrossTenants', undefined, undefined],
    ]);
  });

  it('leaves the member out when the reason is a call, a constant, a template with substitutions, a concatenation or blank', () => {
    expect(tenancy.escapes.filter((e) => !('reason' in e)).map((e) => e.kind)).to.deep.equal(['acrossTenants', ...Array<string>(5).fill('runAcrossTenants')]);
  });

  it('skips a method and a function of the same name that the tenancy packages do not declare', () => {
    expect(tenancy.escapes.map((e) => e.source.file).filter((file) => file !== 'src/escapes.ts')).to.deep.equal([]);
  });

  it('points an acrossTenants escape at the method name, where an ignore comment goes', () => {
    expect(tenancy.escapes[0].source).to.deep.equal({ file: 'src/escapes.ts', line: 8, col: 25, package: 'tenancy-pkg' });
  });

  it('records spinajs-tenancy-ignore comments', () => {
    expect(tenancy.ignores).to.deep.equal([{ code: 'TEN002', reason: 'the usage export reads every tenant on purpose', source: { file: 'src/ignored.ts', line: 1, col: 1, package: 'tenancy-pkg' } }]);
  });
});

describe('tenancy walks of a program without a tenancy package', () => {
  const lookups = async (name: string): Promise<number> => {
    const { controllers, authz } = await fixture(name);
    const loaded = createProgramFromTsconfig(`test/fixtures/${name}/tsconfig.json`);
    const ctx = createContext(loaded, name, `test/fixtures/${name}`);
    let count = 0;
    const getSymbolAtLocation = (node: ts.Node): ts.Symbol | undefined => {
      count++;
      return ctx.checker.getSymbolAtLocation(node);
    };
    const spied = { ...ctx, checker: { ...ctx.checker, getSymbolAtLocation } };
    escapesIn(loaded.sourceFiles, spied);
    tenantModelsOf(spied, loaded.sourceFiles, []);
    tenancySectionOf(spied, loaded.sourceFiles, { controllers, schedules: [], authz, models: [] });
    return count;
  };

  it('resolve no call, decorator or registration', async () => {
    expect(await lookups('authz-pkg')).to.equal(0);
    expect(await lookups('tenancy-pkg')).to.be.greaterThan(0);
  });
});
