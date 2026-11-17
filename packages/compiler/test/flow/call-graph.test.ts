import { expect } from 'chai';
import ts from 'typescript';
import { CallGraph, createProgramFromTsconfig } from '../../src/index.js';

describe('flow: CallGraph', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/authz-flow/tsconfig.json');
  const graph = new CallGraph(loaded.program, loaded.sourceFiles);

  /** Every call inside `Class.method` (or a top-level function), outermost first. */
  function callsIn(owner: string): ts.CallExpression[] {
    const out: ts.CallExpression[] = [];
    for (const file of loaded.sourceFiles) {
      const visit = (node: ts.Node, inside: boolean): void => {
        const here = inside || ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && graph.nameOf(node) === owner);
        if (here && ts.isCallExpression(node)) out.push(node);
        ts.forEachChild(node, (n) => visit(n, here));
      };
      visit(file, false);
    }
    return out;
  }

  /** The calls of `owner` the graph follows or gives up on: callee text, targets, opaque. */
  function followed(owner: string): Array<[string, string[], boolean]> {
    const rows = callsIn(owner).map((c): [string, string[], boolean] => {
      const r = graph.resolve(c);
      return [c.expression.getText(), r.targets.map((t) => `${graph.nameOf(t.fn)}:${t.via}`), r.opaque];
    });
    return rows.filter(([, targets, opaque]) => targets.length > 0 || opaque);
  }

  const external = (owner: string): string[] =>
    callsIn(owner)
      .filter((c) => graph.resolve(c).external)
      .map((c) => c.expression.getText());

  it('the fixture type-checks', () => {
    const errors = ts.getPreEmitDiagnostics(loaded.program).filter((d) => d.category === ts.DiagnosticCategory.Error);
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).to.deep.equal([]);
  });

  it('follows an injected service and a private helper', () => {
    expect(followed('InvoicesController.overdue')).to.deep.equal([['this.Invoices.overdue', ['InvoiceService.overdue:injected'], false]]);
    expect(followed('InvoiceService.overdue')).to.deep.equal([['this.withAge', ['InvoiceService.withAge:direct'], false]]);
  });

  it('resolves an abstract token declared in another file to the class registered for it', () => {
    expect(followed('InvoiceService.stored')).to.deep.equal([['this.Store.open', ['DbInvoiceStore.open:injected'], false]]);
  });

  it('resolves an interface imported as a type to the class that implements it', () => {
    expect(followed('report')).to.deep.equal([['reader.byStatus', ['SqlInvoiceReader.byStatus:implementation'], false]]);
  });

  it('resolves DI.resolve(T).method() through T', () => {
    expect(followed('resolvedOverdue')).to.deep.equal([['DI.resolve(InvoiceService).overdue', ['InvoiceService.overdue:resolve'], false]]);
  });

  it('adds the override a subclass declares', () => {
    expect(followed('InvoicesController.reports')).to.deep.equal([['this.Reports.rows', ['ReportService.rows:injected', 'LegacyReportService.rows:injected'], false]]);
  });

  it('a callback parameter is opaque, a call into a dependency external, a language built-in neither', () => {
    expect(followed('InvoiceService.each')).to.deep.equal([['visit', [], true]]);
    expect(external('resolvedOverdue')).to.deep.equal(['DI.resolve']);
    expect(external('InvoiceService.both')).to.deep.equal(['Invoice.where', "Invoice.where('Status', 'paid').accessible", 'Invoice.where']);
    expect(graph.resolve(callsIn('InvoiceService.both')[0])).to.deep.equal({ targets: [], opaque: false, external: false });
  });

  it('names the program function an argument refers to', () => {
    const [, map] = callsIn('InvoiceService.sweep');
    expect(graph.referenced(map.arguments[0]).map((t) => `${graph.nameOf(t.fn)}:${t.via}`)).to.deep.equal(['InvoiceService.remove:reference']);
    expect(graph.referenced(callsIn('resolvedOverdue')[1].arguments[0])).to.deep.equal([]);
  });

  it('a function value handed on is opaque when the program does not determine it, and the receiver of f.call is handed too', () => {
    const [, map] = callsIn('GapService.visitAll');
    expect(graph.handed(map.arguments[0])).to.deep.equal({ targets: [], opaque: true, external: false });
    const [call] = callsIn('GapService.bound');
    expect(graph.handedTo(call).map((e) => e.getText())).to.deep.equal(['this.remove', 'this', 'id']);
    expect(graph.handed(graph.handedTo(call)[0]).targets.map((t) => `${graph.nameOf(t.fn)}:${t.via}`)).to.deep.equal(['GapService.remove:reference']);
    expect(graph.handed(callsIn('resolvedOverdue')[1].arguments[0])).to.deep.equal({ targets: [], opaque: false, external: false });
  });

  it('follows every member of a union callee, also where the checker merged the operands of a choice into one type', () => {
    const both = ['MemoryStore.list:direct', 'TableStore.list:direct'];
    expect(followed('ChoiceShapes.picked')).to.deep.equal([['store.list', both, false]]);
    expect(followed('ChoiceShapes.inline')).to.deep.equal([['(cached ? new MemoryStore() : new TableStore()).list', both, false]]);
    expect(followed('ChoiceShapes.typed')).to.deep.equal([['store.list', both, false]]);
    expect(followed('ChoiceShapes.keyed')).to.deep.equal([['this[key]', ['ChoiceShapes.first:direct', 'ChoiceShapes.second:direct'], false]]);
    expect(followed('ChoiceShapes.chosen')).to.deep.equal([['list', ['listOpen:direct', 'listAll:direct'], false]]);
  });

  it('resolves an interface a base class implements to the subclasses too', () => {
    expect(followed('viaBase')).to.deep.equal([['lister.list', ['BaseLister.list:implementation', 'LeafLister.list:implementation'], false]]);
    expect(followed('viaAbstractBase')).to.deep.equal([['counter.count', ['CounterBase.count:implementation'], false]]);
  });

  it('finds the getter that implements an interface property or an abstract property', () => {
    const reads = (owner: string): string[][] => {
      const out: string[][] = [];
      for (const file of loaded.sourceFiles) {
        const visit = (node: ts.Node, inside: boolean): void => {
          const here = inside || ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && graph.nameOf(node) === owner);
          if (here && ts.isPropertyAccessExpression(node)) out.push(graph.getter(node).map((t) => `${graph.nameOf(t.fn)}:${t.via}`));
          ts.forEachChild(node, (n) => visit(n, here));
        };
        visit(file, false);
      }
      return out;
    };
    expect(reads('readPosition')).to.deep.equal([['TableCursor.position:implementation']]);
    expect(reads('Paged.next')).to.deep.equal([['FirstPage.page:implementation']]);
  });

  it('an optional callback handed on is opaque', () => {
    const [call] = callsIn('maybeLater');
    expect(graph.handed(call.arguments[0])).to.deep.equal({ targets: [], opaque: true, external: false });
  });

  it('follows this.method() in a static method to the static override of a subclass', () => {
    expect(followed('Maker.run')).to.deep.equal([['this.make', ['Maker.make:direct', 'SubMaker.make:implementation'], false]]);
  });
});
