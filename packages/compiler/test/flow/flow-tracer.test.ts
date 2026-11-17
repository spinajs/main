import { expect } from 'chai';
import ts from 'typescript';
import { CallGraph, FlowTracer, builderOf, createProgramFromTsconfig, isSystemRunAs, literalReason } from '../../src/index.js';
import type { FunctionLike, FunctionSummary } from '../../src/index.js';

describe('flow: effects and the tracer across calls', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/authz-flow/tsconfig.json');
  const { checker } = loaded;
  const graph = new CallGraph(loaded.program, loaded.sourceFiles);

  function nodes<T extends ts.Node>(root: ts.Node, is: (n: ts.Node) => n is T): T[] {
    const out: T[] = [];
    const visit = (n: ts.Node): void => {
      if (is(n)) out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
  }

  function fn(name: string): FunctionLike {
    const found = loaded.sourceFiles.flatMap((f) => nodes(f, ts.isMethodDeclaration)).find((m) => graph.nameOf(m) === name);
    if (found === undefined) throw new Error(`no method ${name}`);
    return found;
  }

  function returned(name: string): ts.Expression {
    const expression = nodes(fn(name), ts.isReturnStatement).at(0)?.expression;
    if (expression === undefined) throw new Error(`${name} returns nothing`);
    return expression;
  }

  const systemRuns = (name: string): ts.CallExpression[] => nodes(fn(name), ts.isCallExpression).filter((c) => isSystemRunAs(c, checker));

  /** A tracer that has seen the parameters and the statements of `name`. */
  function trace(name: string, summaries: ReadonlyMap<FunctionLike, FunctionSummary>): FlowTracer {
    const tracer = new FlowTracer(checker, graph, summaries);
    tracer.seedParameters(fn(name));
    nodes(fn(name), (_n): _n is ts.Node => true).forEach((n) => tracer.observe(n));
    return tracer;
  }

  it('names the ORM builder a type is and the model it queries', () => {
    const [q, days] = fn('InvoiceService.withAge').parameters;
    expect(builderOf(checker, checker.getTypeAtLocation(q))).to.deep.equal({ kind: 'select', model: 'Invoice' });
    expect(builderOf(checker, checker.getTypeAtLocation(days))).to.equal(undefined);
  });

  it('tells runAs(SYSTEM, reason, fn) and reads a literal reason only', () => {
    expect(systemRuns('InvoiceService.nightly').map((c) => literalReason(c.arguments[1]))).to.deep.equal(['nightly export']);
    expect(systemRuns('InvoiceService.purge').map((c) => literalReason(c.arguments[1]))).to.deep.equal([undefined]);
    expect(systemRuns('InvoiceService.overdue')).to.deep.equal([]);
  });

  it('a builder-typed parameter is a pending builder that remembers its index', () => {
    const tracer = trace('InvoiceService.withAge', new Map());
    const traced = tracer.traced(returned('InvoiceService.withAge'));
    expect([traced?.pending, traced?.value.model]).to.deep.equal([true, 'Invoice']);
    expect(traced === undefined ? undefined : tracer.metaOf(traced.value)).to.deep.include({ kind: 'select', param: 0 });
  });

  it('a call that hands a builder back is that builder, with the origin and scoping of the argument it was built from', () => {
    const withAge: FunctionSummary = { effects: [], systemRuns: [], executes: new Map(), returns: { kind: 'select', model: 'Invoice', scoped: { accessible: false, unscoped: false }, param: 0 } };
    const tracer = trace('InvoiceService.overdue', new Map([[fn('InvoiceService.withAge'), withAge]]));
    const traced = tracer.traced(returned('InvoiceService.overdue'));
    expect([traced?.pending, traced?.value.model, traced?.value.scoped]).to.deep.equal([true, 'Invoice', { accessible: false, unscoped: false }]);
    expect(traced === undefined ? undefined : tracer.metaOf(traced.value).origin.getText()).to.equal("Invoice.where('Status', 'open')");
  });

  it('a scoped argument scopes only what the targets that hand it back return, not a fresh builder of another target', () => {
    const handedBack: FunctionSummary = { effects: [], systemRuns: [], executes: new Map(), returns: { kind: 'select', model: 'Invoice', scoped: { accessible: false, unscoped: false }, param: 0 } };
    const fresh: FunctionSummary = { effects: [], systemRuns: [], executes: new Map(), returns: { kind: 'select', model: 'Invoice', scoped: { accessible: false, unscoped: false } } };
    const tracer = trace('HandedShapes.scopedThenHanded', new Map([[fn('Narrowing.narrow'), handedBack], [fn('FreshNarrowing.narrow'), fresh]]));
    const traced = tracer.traced(returned('HandedShapes.scopedThenHanded'));
    expect([traced?.pending, traced?.value.scoped]).to.deep.equal([true, { accessible: false, unscoped: false }]);
    const both = trace('HandedShapes.scopedThenHanded', new Map([[fn('Narrowing.narrow'), handedBack], [fn('FreshNarrowing.narrow'), handedBack]]));
    expect(both.traced(returned('HandedShapes.scopedThenHanded'))?.value.scoped).to.deep.equal({ accessible: true, unscoped: false });
  });

  it('a builder the tracer cannot follow is read from its type, made where the expression stands', () => {
    const tracer = trace('InvoiceService.overdue', new Map());
    const traced = tracer.traced(returned('InvoiceService.overdue'));
    expect([traced?.pending, traced?.value.model, traced?.value.scoped]).to.deep.equal([true, 'Invoice', { accessible: false, unscoped: false }]);
    expect(traced === undefined ? undefined : tracer.metaOf(traced.value).origin.getText()).to.equal('this.withAge(q, days)');
  });

  it('a choice between builders is one builder: scoped only when every operand is, made where the choice stands', () => {
    const tracer = trace('GapService.either', new Map());
    const traced = tracer.traced(returned('GapService.either'));
    expect([traced?.pending, traced?.value.model, traced?.value.scoped]).to.deep.equal([true, 'Invoice', { accessible: false, unscoped: false }]);
    expect(traced === undefined ? undefined : tracer.metaOf(traced.value).origin.getText()).to.equal("all ? Invoice.query() : Invoice.where('Status', 'open').accessible('invoice:read')");
  });

  it('a chain rooted at a model class takes its kind from what the static member returns', () => {
    const kindOf = (name: string, expression: (owner: FunctionLike) => ts.Expression): string | undefined => {
      const tracer = trace(name, new Map());
      const traced = tracer.traced(expression(fn(name)));
      return traced === undefined ? undefined : tracer.metaOf(traced.value).kind;
    };
    const awaited = (owner: FunctionLike): ts.Expression => nodes(owner, ts.isAwaitExpression)[0].expression;
    expect(kindOf('InvoiceService.archive', awaited)).to.equal('update');
    expect(kindOf('InvoiceService.listed', () => returned('InvoiceService.listed'))).to.equal('select');
    expect(kindOf('GapService.added', awaited)).to.equal('other');
    expect(kindOf('GapService.added', () => returned('GapService.added'))).to.equal('other');
  });

  /** What `name` returns: pending or not, and its scope; `undefined` when the tracer has no builder there. */
  function returnedScope(name: string, summaries: ReadonlyMap<FunctionLike, FunctionSummary> = new Map()): [boolean, { accessible: boolean; unscoped: boolean }] | undefined {
    const traced = trace(name, summaries).traced(returned(name));
    return traced === undefined ? undefined : [traced.pending, traced.value.scoped];
  }

  const UNSCOPED = { accessible: false, unscoped: false };

  it('a builder whose type is optional, a union with undefined or a constrained type parameter is a builder', () => {
    expect(returnedScope('OptionalShapes.optionalParam')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('OptionalShapes.asserted')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('OptionalShapes.generic')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('OptionalShapes.fromMap')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('OptionalShapes.field')).to.deep.equal([true, UNSCOPED]);
  });

  it('a default for an optional builder, or for a value of type any, leaves the choice unscoped', () => {
    expect(returnedScope('OptionalShapes.nullishOptional')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('OptionalShapes.orUnion')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('OptionalShapes.anyOperand')).to.deep.equal([true, UNSCOPED]);
  });

  it('a scoped return of a followed target does not speak for an opaque or external member of the same call', () => {
    const scoped: FunctionSummary = { effects: [], systemRuns: [], executes: new Map(), returns: { kind: 'select', model: 'Invoice', scoped: { accessible: true, unscoped: false } } };
    const call = (owner: string): ts.CallExpression => {
      const expression = returned(owner);
      if (!ts.isCallExpression(expression)) throw new Error(`${owner} returns no call`);
      return expression;
    };
    const flags = (owner: string): [string[], boolean, boolean] => {
      const resolved = graph.resolve(call(owner));
      return [resolved.targets.map((t) => graph.nameOf(t.fn)), resolved.opaque, resolved.external];
    };
    expect(flags('MakerShapes.picked')).to.deep.equal([['LocalMaker.make'], true, false]);
    expect(flags('MakerShapes.external')).to.deep.equal([['LocalCloner.clone'], false, true]);
    expect(returnedScope('MakerShapes.picked', new Map([[fn('LocalMaker.make'), scoped]]))).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('MakerShapes.external', new Map([[fn('LocalCloner.clone'), scoped]]))).to.deep.equal([true, UNSCOPED]);
    const noReturn: FunctionSummary = { effects: [], systemRuns: [], executes: new Map() };
    const twoTargets = new Map([[fn('Narrowing.narrow'), scoped], [fn('FreshNarrowing.narrow'), noReturn]]);
    expect(returnedScope('HandedShapes.scopedThenHanded', twoTargets)).to.deep.equal([true, UNSCOPED]);
  });

  it('a builder variable reassigned is scoped only when every value it held is, and scoping a clone leaves it as it was', () => {
    expect(returnedScope('ReassignedShapes.reassigned')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('ReassignedShapes.scopedLater')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('ReassignedShapes.clonedScope')).to.deep.equal([true, UNSCOPED]);
  });

  it('a builder read from its type is scoped only by calls made on a builder', () => {
    expect(returnedScope('HelperShapes.chained')).to.deep.equal([true, UNSCOPED]);
  });

  it('a builder cast from any or unknown is a builder, and a choice with it is unscoped', () => {
    expect(returnedScope('CastShapes.castFromAny')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('CastShapes.castFromUnknown')).to.deep.equal([true, UNSCOPED]);
    expect(returnedScope('CastShapes.castChoiceFromAny')).to.deep.equal([true, UNSCOPED]);
  });
});
