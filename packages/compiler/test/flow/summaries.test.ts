import { expect } from 'chai';
import ts from 'typescript';
import { CallGraph, createProgramFromTsconfig } from '../../src/index.js';
import { summarize } from '../../src/flow/index.js';
import type { FunctionLike } from '../../src/index.js';

describe('flow: summarize', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/authz-flow/tsconfig.json');
  const graph = new CallGraph(loaded.program, loaded.sourceFiles);

  function fn(name: string): FunctionLike {
    let found: FunctionLike | undefined;
    const visit = (node: ts.Node): void => {
      if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && graph.nameOf(node) === name) found = node;
      ts.forEachChild(node, visit);
    };
    loaded.sourceFiles.forEach(visit);
    if (found === undefined) throw new Error(`no ${name}`);
    return found;
  }

  const run = (root: string) => summarize(graph, loaded.checker, [fn(root)]);
  const effectsOf = (root: string) => (run(root).summaries.get(fn(root))?.effects ?? []).map((e) => [e.kind, e.model, e.scoped, e.reason ?? null, e.path.map((s) => `${s.name}:${s.via}`).join(' > ')]);
  const sitesOf = (root: string) => (run(root).summaries.get(fn(root))?.effects ?? []).map((e) => e.site.getText());

  it('UC1: a builder in a variable, passed to a helper that returns it, executed by the async caller', () => {
    expect(effectsOf('InvoicesController.overdue')).to.deep.equal([['read-many', 'Invoice', 'none', null, 'InvoiceService.overdue:injected']]);
    expect(sitesOf('InvoicesController.overdue')).to.deep.equal(["Invoice.where('Status', 'open')"]);
  });

  it('a scoped list is accessible', () => {
    expect(effectsOf('InvoicesController.listed')).to.deep.equal([['read-many', 'Invoice', 'accessible', null, 'InvoiceService.listed:injected']]);
  });

  it('through an abstract injected store to its implementation in another file', () => {
    expect(effectsOf('InvoicesController.stored')).to.deep.equal([['read-many', 'Invoice', 'none', null, 'InvoiceService.stored:injected > DbInvoiceStore.open:injected']]);
  });

  it('an override in a subclass is one of the things an injected call may run', () => {
    expect(effectsOf('InvoicesController.reports')).to.deep.equal([
      ['read-many', 'Invoice', 'accessible', null, 'ReportService.rows:injected'],
      ['read-many', 'Invoice', 'none', null, 'LegacyReportService.rows:injected'],
    ]);
  });

  it('an update builder executed without scoping', () => {
    expect(effectsOf('InvoicesController.archive')).to.deep.equal([['update', 'Invoice', 'none', null, 'InvoiceService.archive:injected']]);
  });

  it('runAs(SYSTEM, reason) makes the callback system-scoped and keeps a literal reason', () => {
    expect(effectsOf('InvoicesController.nightly')).to.deep.equal([['read-many', 'Invoice', 'system', 'nightly export', 'InvoiceService.nightly:injected']]);
    const purge = run('InvoicesController.purge').summaries.get(fn('InvoicesController.purge'));
    expect(purge?.effects.map((e) => [e.kind, e.scoped, e.reason ?? null])).to.deep.equal([['delete', 'system', null]]);
    expect(purge?.systemRuns.map((r) => [r.reason ?? null, r.path.map((s) => s.name).join(' > ')])).to.deep.equal([[null, 'InvoiceService.purge']]);
  });

  it('a job reaching the service through DI.resolve', () => {
    expect(effectsOf('OverdueJob.execute')).to.deep.equal([['read-many', 'Invoice', 'none', null, 'resolvedOverdue:direct > InvoiceService.overdue:resolve']]);
  });

  it('builders handed to code the pass cannot follow count as executed there', () => {
    expect(effectsOf('InvoiceService.both')).to.deep.equal([
      ['read-many', 'Invoice', 'none', null, ''],
      ['read-many', 'Invoice', 'accessible', null, ''],
    ]);
  });

  it('a builder passed to a helper that executes its parameter is reported at the call, where its scoping is known', () => {
    const { summaries } = run('InvoiceService.ran');
    expect([...(summaries.get(fn('InvoiceService.run'))?.executes ?? [])]).to.deep.equal([[0, 'select']]);
    expect(summaries.get(fn('InvoiceService.run'))?.effects).to.deep.equal([]);
    expect(effectsOf('InvoiceService.ran')).to.deep.equal([['read-many', 'Invoice', 'none', null, '']]);
    expect(sitesOf('InvoiceService.ran')).to.deep.equal(["Invoice.where('Status', 'draft')"]);
  });

  it('a function passed by name counts as called', () => {
    expect(effectsOf('InvoiceService.sweep')).to.deep.equal([['delete', 'Invoice', 'none', null, 'InvoiceService.remove:reference']]);
  });

  it('counts the calls it cannot follow', () => {
    const each = run('InvoiceService.each');
    expect(each.summaries.get(fn('InvoiceService.each'))?.effects.map((e) => [e.kind, e.scoped])).to.deep.equal([['read-many', 'accessible']]);
    expect([each.opaqueCalls, each.externalCalls]).to.deep.equal([1, 2]);
  });

  it('a builder under a choice is executed operand by operand where it is passed on, and as one builder where it was bound', () => {
    expect(effectsOf('GapService.chosen')).to.deep.equal([
      ['read-many', 'Invoice', 'none', null, ''],
      ['read-many', 'Invoice', 'accessible', null, ''],
    ]);
    expect(sitesOf('GapService.chosen')).to.deep.equal(['Invoice.query()', "Invoice.where('Status', 'open').accessible('invoice:read')"]);
    expect(effectsOf('GapService.either')).to.deep.equal([['read-many', 'Invoice', 'none', null, '']]);
    expect(sitesOf('GapService.either')).to.deep.equal(["all ? Invoice.query() : Invoice.where('Status', 'open').accessible('invoice:read')"]);
  });

  it('a callback parameter handed on to a built-in counts as opaque, and a function run through f.call is followed', () => {
    const visited = run('GapService.visitAll');
    expect([visited.opaqueCalls, visited.externalCalls]).to.deep.equal([1, 0]);
    expect(effectsOf('GapService.bound')).to.deep.equal([['delete', 'Invoice', 'none', null, 'GapService.remove:reference']]);
  });

  it('what an entry root returns is run by the framework; called from the package, the same function hands its builder back', () => {
    expect(effectsOf('GapService.handedOut')).to.deep.equal([['read-many', 'Invoice', 'none', null, '']]);
    expect(sitesOf('GapService.handedOut')).to.deep.equal(["Invoice.where('Status', 'late')"]);
    const { summaries } = run('GapService.scopedLater');
    expect(summaries.get(fn('GapService.handedOut'))?.effects).to.deep.equal([]);
    expect(effectsOf('GapService.scopedLater')).to.deep.equal([['read-many', 'Invoice', 'accessible', null, '']]);
  });

  it('an insert and an existence test are effects of their own kind, not multi-row reads', () => {
    expect(effectsOf('GapService.added')).to.deep.equal([
      ['other', 'Invoice', 'none', null, ''],
      ['other', 'Invoice', 'none', null, ''],
    ]);
  });

  it('settles on recursion: one effect per query site, the shortest path kept', () => {
    const cycle = run('walk');
    expect(effectsOf('walk')).to.deep.equal([['read-many', 'Invoice', 'none', null, '']]);
    expect((cycle.summaries.get(fn('climb'))?.effects ?? []).map((e) => e.path.map((s) => s.name).join(' > '))).to.deep.equal(['walk']);
    expect(cycle.opaqueCalls).to.equal(0);
  });
});
