import { expect } from 'chai';
import ts from 'typescript';
import { createProgramFromTsconfig, createContext, literalValue, decoratorsOf, identifierName, isArrayOfType } from '../src/index.js';

const src = `
import { OBJ, Kind, Base } from './context.js';
declare function D(...a: unknown[]): any;
@D('s', 2, true, null, [1, 'x'], { k: 'v', n: [OBJ] }, OBJ, Kind.A, Base, someCall())
export class X {}
declare function someCall(): unknown;
`;
describe('decorators helpers', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/unit/tsconfig.json');
  const ctx = createContext(loaded, 'unit', 'test/fixtures/unit');
  const sf = ts.createSourceFile('inline.ts', src, ts.ScriptTarget.ES2021, true);
  const cls = sf.statements.find(ts.isClassDeclaration)!;
  const [dec] = decoratorsOf(cls);

  it('reads name and args', () => {
    expect(dec.name).to.equal('D');
    expect(dec.args).to.have.length(10);
  });
  it('literalValue handles primitives, arrays, objects and enum members, and reports the rest', () => {
    const before = ctx.diagnostics.length;
    expect(dec.args.slice(0, 6).map((a) => literalValue(a, ctx))).to.deep.equal(['s', 2, true, null, [1, 'x'], { k: 'v', n: [undefined] }]);
    expect(literalValue(dec.args[9], ctx)).to.equal(undefined);
    expect(ctx.diagnostics.slice(before).map((d) => d.code)).to.deep.equal(['CMP001', 'CMP001']);
  });
  it('literalValue resolves constants, enum members and classes through the checker', () => {
    const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('decorated.ts'))!;
    const decorated = file.statements.find(ts.isClassDeclaration)!;
    const [d] = decoratorsOf(decorated);
    expect(d.args.map((a) => literalValue(a, ctx))).to.deep.equal([{ a: 1, b: ['x', 'y'], c: { d: true } }, 'alpha', 'Base']);
  });
  it('identifierName and isArrayOfType', () => {
    const arr = ts.createSourceFile('a.ts', 'Array.ofType(Foo)', ts.ScriptTarget.ES2021, true).statements[0] as ts.ExpressionStatement;
    expect(identifierName(arr.expression)).to.equal('Foo');
    expect(isArrayOfType(arr.expression)).to.be.true;
    expect(identifierName(dec.args[8])).to.equal('Base');
  });
});
