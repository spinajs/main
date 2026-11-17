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

  const UNSCOPED_READ = [['read-many', 'Invoice', 'none', null, '']];

  it('a builder that may be several kinds or models reports each of them, and of a join only those left unscoped', () => {
    expect(effectsOf('VariantShapes.kinds')).to.deep.equal([
      ['update', 'Invoice', 'none', null, ''],
      ['delete', 'Invoice', 'none', null, ''],
    ]);
    expect(effectsOf('VariantShapes.models')).to.deep.equal([
      ['read-many', 'Invoice', 'none', null, ''],
      ['read-many', 'Note', 'none', null, ''],
    ]);
    expect(effectsOf('VariantShapes.sources')).to.deep.equal([
      ['read-many', 'Invoice', 'none', null, ''],
      ['read-many', 'Note', 'none', null, ''],
    ]);
    expect(sitesOf('VariantShapes.sources')).to.deep.equal(['(c ? new InvoiceSource() : new NoteSource()).make()', '(c ? new InvoiceSource() : new NoteSource()).make()']);
    expect(effectsOf('VariantShapes.reassigned')).to.deep.equal([['read-many', 'Note', 'none', null, '']]);
  });

  it('a builder variable reassigned later in a loop or after a closure that reads it holds every value it is given', () => {
    expect(effectsOf('LoopShapes.reassignedLater')).to.deep.equal(UNSCOPED_READ);
    expect(sitesOf('LoopShapes.reassignedLater')).to.deep.equal(['Invoice.query()']);
    expect(effectsOf('LoopShapes.carried')).to.deep.equal(UNSCOPED_READ);
    expect(sitesOf('LoopShapes.carried')).to.deep.equal(["Invoice.where('Status', 'open')"]);
    expect(effectsOf('LoopShapes.deferred')).to.deep.equal(UNSCOPED_READ);
    expect(effectsOf('LoopShapes.narrowed')).to.deep.equal([['read-many', 'Invoice', 'accessible', null, '']]);
  });

  it('a for…of that writes into a builder variable leaves it unscoped', () => {
    expect(effectsOf('LoopShapes.reused')).to.deep.equal(UNSCOPED_READ);
    expect(sitesOf('LoopShapes.reused')).to.deep.equal(['list']);
  });

  it('a builder handed around a cycle settles unscoped when one turn of it is', () => {
    const rally = run('rally');
    expect(effectsOf('rally')).to.deep.equal(UNSCOPED_READ);
    expect(rally.summaries.get(fn('ping'))?.returns?.scoped).to.deep.equal({ accessible: false, unscoped: false });
    expect(effectsOf('endless')).to.deep.equal(UNSCOPED_READ);
    expect([rally.opaqueCalls, run('endless').opaqueCalls]).to.deep.equal([0, 0]);
  });

  it('an argument a call may hand to an opaque member beside a followed one counts as executed', () => {
    expect(effectsOf('CallShapes.handedAside')).to.deep.equal(UNSCOPED_READ);
    expect(sitesOf('CallShapes.handedAside')).to.deep.equal(['Invoice.query()']);
    expect(run('CallShapes.handedAside').opaqueCalls).to.equal(1);
  });

  it('a variable that may hold a parameter or a fresh builder does not hand the parameter back', () => {
    expect(effectsOf('CallShapes.picked')).to.deep.equal(UNSCOPED_READ);
    expect(run('CallShapes.picked').summaries.get(fn('CallShapes.pick'))?.returns).to.deep.equal({ kind: 'select', model: 'Invoice', scoped: { accessible: false, unscoped: false } });
  });

  it('a root runs its builder parameter, a default parameter and a yielded builder, and a promise of rows runs where it is called', () => {
    expect(effectsOf('CallShapes.rootParam')).to.deep.equal(UNSCOPED_READ);
    expect(effectsOf('OptionalShapes.generic')).to.deep.equal(UNSCOPED_READ);
    expect(effectsOf('CallShapes.omitted')).to.deep.equal([['read-many', 'Invoice', 'none', null, 'CallShapes.defaulted:direct']]);
    expect(effectsOf('CallShapes.streamed')).to.deep.equal(UNSCOPED_READ);
    expect(effectsOf('CallShapes.floating')).to.deep.equal(UNSCOPED_READ);
    expect(sitesOf('CallShapes.floating')).to.deep.equal(['Invoice.find([1])']);
  });

  it('a variable that held rows and then a builder runs the builder, and a closure scopes only the builders it declares', () => {
    expect(effectsOf('LateShapes.rowsThenBuilder')).to.deep.equal([['read-many', 'Invoice', 'accessible', null, ''], ...UNSCOPED_READ]);
    expect(effectsOf('LateShapes.scopedInCallback')).to.deep.equal(UNSCOPED_READ);
  });

  it('the shapes the tracer reads conservatively stay unscoped where a root runs them', () => {
    // A returned `??` runs operand by operand: the scoped default is an effect of its own.
    for (const root of ['OptionalShapes.nullishOptional', 'CastShapes.castChoiceFromAny']) {
      expect(effectsOf(root), root).to.deep.equal([...UNSCOPED_READ, ['read-many', 'Invoice', 'accessible', null, '']]);
    }
    for (const root of ['LogicalAssignShapes.nullishAssigned', 'DestructuredShapes.fromArray', 'UnexplainedShapes.unexplainedFirst', 'MakerShapes.picked']) {
      expect(effectsOf(root), root).to.deep.equal(UNSCOPED_READ);
    }
  });
});
