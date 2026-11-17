import { expect } from 'chai';
import ts from 'typescript';
import type { AuthzSection } from '@spinajs/manifest';
import { analyzePackage, createContext, createProgramFromTsconfig } from '../../src/index.js';
import { authzFlowOf } from '../../src/extractors/authz-flow.js';

describe('authz flow findings', () => {
  let authz: AuthzSection;
  before(async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/authz-flow/tsconfig.json', packageRoot: 'test/fixtures/authz-flow' });
    if (fragment.authz === undefined) throw new Error('the fixture has no authz section');
    authz = fragment.authz;
  });

  const at = (code: string) => authz.findings.filter((f) => f.code === code).map((f) => [f.source?.file, f.source?.line, f.severity, f.message]);
  const read = (route: string, path: string, more = '') => `route GET /invoices/${route} reaches an unscoped multi-row read of access resource 'invoice' (Invoice); path: ${path}${more}`;

  it('AUTHZ001 names the first entry point and its call path for every unscoped multi-row read', () => {
    expect(at('AUTHZ001')).to.deep.equal([
      ['src/db-store.ts', 9, 'warning', read('stored', 'InvoicesController.stored -> InvoiceService.stored (injected) -> DbInvoiceStore.open (injected)')],
      ['src/services.ts', 13, 'warning', read('overdue', 'InvoicesController.overdue -> InvoiceService.overdue (injected)', ', and 1 more entry point')],
      ['src/services.ts', 38, 'warning', read('both', 'InvoicesController.both -> InvoiceService.both (injected)')],
      ['src/services.ts', 42, 'warning', read('ran', 'InvoicesController.ran -> InvoiceService.ran (injected)')],
      ['src/services.ts', 72, 'warning', read('reports', 'InvoicesController.reports -> LegacyReportService.rows (injected)')],
    ]);
  });

  it('AUTHZ002 for an unscoped update; a delete under runAs(SYSTEM) is not one', () => {
    expect(at('AUTHZ002')).to.deep.equal([
      ['src/services.ts', 26, 'warning', "route GET /invoices/archive reaches an unscoped update of access resource 'invoice' (Invoice); path: InvoicesController.archive -> InvoiceService.archive (injected)"],
    ]);
  });

  it('AUTHZ006 for runAs(SYSTEM) with a reason that is not a literal', () => {
    expect(at('AUTHZ006')).to.deep.equal([['src/services.ts', 30, 'warning', 'route GET /invoices/purge runs as SYSTEM with no literal reason; path: InvoicesController.purge -> InvoiceService.purge (injected)']]);
  });

  it('reports nothing else', () => {
    expect([...new Set(authz.findings.map((f) => f.code))].sort()).to.deep.equal(['AUTHZ001', 'AUTHZ002', 'AUTHZ006']);
  });

  it('records what it covered and what it could not follow', () => {
    const { externalCalls, ...flow } = authz.flow;
    expect(flow).to.deep.equal({ entryPoints: 10, unresolvedRoots: 0, opaqueCalls: 0, foreignModelQueries: 0 });
    expect(externalCalls).to.be.greaterThan(0);
  });

  it('counts entry points, not effects: one entry point reaching a union builder twice at one site is one', () => {
    const loaded = createProgramFromTsconfig('test/fixtures/authz-flow/tsconfig.json');
    const ctx = createContext(loaded, 'authz-flow', 'test/fixtures/authz-flow');
    const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('summarized.ts'));
    const cls = file?.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'UnionDrop');
    if (file === undefined || cls === undefined) throw new Error('UnionDrop is missing from the fixture');
    const section = { entryPoints: [{ kind: 'schedule' as const, id: 'drop', access: [], source: ctx.sourceRef(cls) }], resources: [{ type: 'invoice', model: 'authz-flow:Invoice', relations: [], source: ctx.sourceRef(cls) }] };
    const { findings } = authzFlowOf(ctx, loaded.sourceFiles, section, { controllers: [], socketControllers: [] }, new Set(['Invoice']));
    expect(findings.map((f) => f.message).filter((m) => m.includes('UnionDrop.drop'))).to.deep.equal(["schedule drop reaches an unscoped update of access resource 'invoice' (Invoice); path: UnionDrop.execute -> UnionDrop.drop (reference)"]);
  });

  it('starts at the handler of a socket event, which the manifest entry does not name', async () => {
    const fragment = await analyzePackage({ tsconfig: 'test/fixtures/authz-flow-socket/tsconfig.json', packageRoot: 'test/fixtures/authz-flow-socket' });
    expect(fragment.authz?.findings.map((f) => [f.code, f.source?.line, f.message])).to.deep.equal([
      ['AUTHZ001', 16, "socket event invoices.opened reaches an unscoped multi-row read of access resource 'invoice' (Invoice); path: InvoiceSocket.opened"],
    ]);
    expect(fragment.authz?.flow).to.deep.include({ entryPoints: 1, unresolvedRoots: 0 });
  });
});
