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
  it('isSubclassOf does not throw on a base that is a non-class object type', () => {
    const casted = loaded.sourceFiles.find((f) => f.fileName.endsWith('casted-base.ts'))!;
    const weird = casted.statements.find((st): st is ts.ClassDeclaration => ts.isClassDeclaration(st))!;
    expect(ctx.isSubclassOf(weird, 'Base')).to.be.false;
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

  describe('schema derivation', () => {
    const inner = createContext(loaded, 'unit', 'test/fixtures/unit/inner');
    const innerFile = loaded.sourceFiles.find((f) => f.fileName.endsWith('foreign-use.ts'))!;
    const variable = (name: string) => {
      for (const st of innerFile.statements) {
        if (!ts.isVariableStatement(st)) continue;
        const decl = st.declarationList.declarations.find((d) => (d.name as ts.Identifier).text === name);
        if (decl) return decl;
      }
      throw new Error(name);
    };
    const typeOf = (name: string) => inner.checker.getTypeAtLocation(variable(name));

    it('locates diagnostics of a type declared outside the package at the use site and names the type', () => {
      inner.typeRef(typeOf('used'), variable('used'));
      const diagnostic = inner.diagnostics.find((d) => d.code === 'SCH001')!;
      expect(diagnostic.source).to.deep.equal({ file: 'foreign-use.ts', line: 3, col: 14, package: 'unit' });
      expect(diagnostic.message).to.include('Foreign');
    });
    it('warns SCH005 when one hint names two different schemas, and stays silent for identical ones', () => {
      inner.typeRef(typeOf('other'), variable('other'), 'Hinted');
      inner.typeRef(typeOf('other'), variable('other'), 'Hinted');
      expect(inner.diagnostics.filter((d) => d.code === 'SCH005')).to.deep.equal([]);
      inner.typeRef(typeOf('another'), variable('another'), 'Hinted');
      const collisions = inner.diagnostics.filter((d) => d.code === 'SCH005');
      expect(collisions).to.have.length(1);
      expect(collisions[0].message).to.include('spinajs/unit/Hinted');
    });
  });
});
