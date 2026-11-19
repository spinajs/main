import { expect } from 'chai';
import ts from 'typescript';
import { createProgramFromTsconfig, declarationMarker, symbolMarker, typeMarker } from '../src/index.js';

describe('framework packages mark their declarations', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/authz-flow/tsconfig.json');
  const { checker } = loaded;
  const vocabulary = loaded.sourceFiles.find((f) => f.fileName.endsWith('/src/vocabulary.ts'))!;
  const variable = (name: string): ts.VariableDeclaration => {
    let out: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === name) out = node;
      ts.forEachChild(node, visit);
    };
    visit(vocabulary);
    return out!;
  };
  const calls = (name: string): ts.CallExpression[] => {
    const out: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) out.push(node);
      ts.forEachChild(node, visit);
    };
    visit(variable(name).initializer!);
    return out;
  };
  const kind = (name: string) => typeMarker(checker, checker.getTypeAtLocation(variable(name)), 'query');
  const member = (call: ts.CallExpression) => checker.getSymbolAtLocation((call.expression as ts.PropertyAccessExpression).name);

  it('orm: every builder class and interface, and a subclass, names its query kind, and clone() is a copy', () => {
    expect(['iSelect', 'select', 'selectC', 'iUpdate', 'update', 'iDelete', 'del', 'insert'].map(kind)).to.deep.equal(['select', 'select', 'select', 'update', 'update', 'delete', 'delete', 'insert']);
    expect(calls('copied').map((c) => symbolMarker(checker, member(c), 'copy'))).to.deep.equal(['', '']);
  });

  it('authz-orm: accessible and unscoped are scoping members', () => {
    const [unscoped, accessible] = calls('scoped');
    expect(symbolMarker(checker, member(accessible), 'authz-scope')).to.equal('accessible');
    expect(symbolMarker(checker, member(unscoped), 'authz-scope')).to.equal('unscoped');
  });

  it('authz and principal: runAs runs as a principal, SYSTEM is the system principal', () => {
    const run = calls('systemRun').find((c) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'runAs')!;
    expect(declarationMarker(checker.getResolvedSignature(run)?.getDeclaration(), 'run-as')).to.equal('');
    expect(symbolMarker(checker, checker.getSymbolAtLocation(run.arguments[0]), 'system-principal')).to.equal('');
  });
});
