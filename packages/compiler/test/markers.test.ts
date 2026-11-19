import { expect } from 'chai';
import ts from 'typescript';
import { createProgramFromTsconfig, declarationMarker, isAsyncIterable, isAwaitable, symbolMarker, typeMarker } from '../src/index.js';

describe('declaration markers', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/markers/tsconfig.json');
  const { checker } = loaded;
  const file = (name: string): ts.SourceFile => {
    const found = loaded.sourceFiles.find((f) => f.fileName.endsWith(`/src/${name}`));
    if (found === undefined) throw new Error(`no ${name}`);
    return found;
  };
  const declared = (name: string): ts.Declaration => {
    let out: ts.Declaration | undefined;
    const visit = (node: ts.Node): void => {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText() === name) out = node;
      ts.forEachChild(node, visit);
    };
    visit(file('index.ts'));
    visit(file('use.ts'));
    if (out === undefined) throw new Error(`no ${name}`);
    return out;
  };
  const typeOf = (name: string): ts.Type => checker.getTypeAtLocation(declared(name));
  const returnOf = (name: string): ts.Type => checker.getSignatureFromDeclaration(declared(name) as ts.FunctionDeclaration)!.getReturnType();

  it('reads the value of a role, and an empty value for a role written without one', () => {
    expect(declarationMarker(declared('Base'), 'query')).to.equal('select');
    expect(declarationMarker(declared('run'), 'run-as')).to.equal('');
    expect(declarationMarker(declared('IDel'), 'query')).to.equal('delete');
  });

  it('is undefined for another role, an unmarked declaration and no declaration', () => {
    expect(declarationMarker(declared('Base'), 'run-as')).to.equal(undefined);
    expect(declarationMarker(declared('other'), 'run-as')).to.equal(undefined);
    expect(declarationMarker(undefined, 'query')).to.equal(undefined);
  });

  it('follows an import alias to the declaration that carries the marker', () => {
    const use = declared('aliased') as ts.VariableDeclaration;
    expect(symbolMarker(checker, checker.getSymbolAtLocation(use.initializer!), 'system-principal')).to.equal('');
  });

  it('reads a type marker from the class or interface itself, then from its bases', () => {
    expect(typeMarker(checker, typeOf('sub'), 'query')).to.equal('select');
    expect(typeMarker(checker, typeOf('more'), 'query')).to.equal('update');
    expect(typeMarker(checker, checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation((declared('Plain') as ts.ClassDeclaration).name!)!), 'query')).to.equal(undefined);
  });

  it('tells awaitable and async-iterable results from plain ones', () => {
    expect(isAwaitable(checker, returnOf('rows'))).to.equal(true);
    expect(isAsyncIterable(checker, returnOf('stream'))).to.equal(true);
    expect(isAsyncIterable(checker, returnOf('iterable'))).to.equal(true);
    expect(isAsyncIterable(checker, returnOf('feed'))).to.equal(true);
    expect(isAsyncIterable(checker, returnOf('rows'))).to.equal(false);
    expect(isAwaitable(checker, returnOf('plain'))).to.equal(false);
    expect(isAsyncIterable(checker, returnOf('plain'))).to.equal(false);
  });
});
