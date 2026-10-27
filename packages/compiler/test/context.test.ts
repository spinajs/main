import { expect } from 'chai';
import ts from 'typescript';
import { createProgramFromTsconfig, createContext } from '../src/index.js';

const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('context.ts'))!;
const cls = (name: string) => file.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name)!;
const method = (c: ts.ClassDeclaration, name: string) => c.members.find((m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && (m.name as ts.Identifier).text === name)!;
const returnOf = (m: ts.MethodDeclaration) => ctx.checker.getReturnTypeOfSignature(ctx.checker.getSignatureFromDeclaration(m)!);

describe('ExtractorContext', () => {
  it('sourceRef is package-relative with forward slashes and 1-based line', () => {
    expect(ctx.sourceRef(cls('Base'))).to.deep.equal({ file: 'context.ts', line: 1, col: 1, package: 'unit' });
  });
  it('isSubclassOf walks the whole chain', () => {
    expect(ctx.isSubclassOf(cls('Leaf'), 'Base')).to.be.true;
    expect(ctx.isSubclassOf(cls('Base'), 'Leaf')).to.be.false;
  });
  it('typeRef unwraps Promise and Ok', () => {
    const svc = cls('Svc');
    expect(ctx.typeRef(returnOf(method(svc, 'one')), svc).text).to.equal('Dto');
    expect(ctx.typeRef(returnOf(method(svc, 'two')), svc).text).to.equal('Dto[]');
    expect(ctx.typeRef(returnOf(method(svc, 'three')), svc).text).to.equal('void');
  });
  it('diagnostics carry severity and source', () => {
    ctx.warn('X001', 'hello', cls('Base'));
    expect(ctx.diagnostics.at(-1)).to.deep.equal({ code: 'X001', severity: 'warning', message: 'hello', source: { file: 'context.ts', line: 1, col: 1, package: 'unit' } });
  });
});
