import { expect } from 'chai';
import ts from 'typescript';
import { buildersOf, createProgramFromTsconfig, modelShape } from '../src/index.js';
import { isModelType, modelOf, relationOf } from '../src/model-members.js';
import { extendsFrameworkClass } from '../src/schema/framework-members.js';

describe('model readers: intersections such as populate() rows', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-n-plus-one/tsconfig.json');
  const { checker } = loaded;
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('readers.ts'));
  const declared = (name: string): ts.Type => {
    const declaration = file?.statements.filter(ts.isVariableStatement).flatMap((s) => [...s.declarationList.declarations]).find((d) => d.name.getText() === name);
    if (!declaration) throw new Error(`no ${name} in readers.ts`);
    return checker.getTypeAtLocation(declaration.name);
  };
  const returned = (name: string): ts.Type => declared(name).getCallSignatures()[0].getReturnType();
  const awaited = (name: string): ts.Type => {
    const type = checker.getAwaitedType(returned(name));
    if (!type) throw new Error(`${name} returns nothing awaitable`);
    return type;
  };
  const nameOf = (type: ts.Type | undefined): string | undefined => type?.getSymbol()?.name;
  const elementOf = (type: ts.Type): ts.Type => checker.getTypeArguments(type as ts.TypeReference)[0];
  const memberType = (type: ts.Type, name: string): ts.Type => {
    const property = type.getProperty(name);
    if (!property) throw new Error(`no member ${name}`);
    return checker.getNonNullableType(checker.getTypeOfSymbol(property));
  };

  it('a plain model type is found as itself', () => {
    expect(modelOf(checker, declared('plain'))).to.equal(declared('plain'));
    expect(modelShape(checker, declared('plain'))).to.deep.equal({ model: 'Post', shape: 'one' });
  });

  it('an intersection of a model and an object type is found as the model', () => {
    expect(isModelType(checker, declared('withObject'))).to.equal(false);
    expect(nameOf(modelOf(checker, declared('withObject')))).to.equal('Post');
    expect(modelShape(checker, declared('withObject'))).to.deep.equal({ model: 'Post', shape: 'one' });
  });

  it('an intersection without a model class is not found, however model-shaped', () => {
    expect(modelOf(checker, declared('shapedOnly'))).to.equal(undefined);
    expect(modelShape(checker, declared('shapedOnly'))).to.equal(undefined);
  });

  it('an intersection of two different models names neither', () => {
    expect(modelOf(checker, declared('twoModels'))).to.equal(undefined);
    expect(modelShape(checker, declared('twoModels'))).to.equal(undefined);
  });

  it("the awaited rows of populate('Owner') are many Post, and the populated Owner is a SingleRelation of User", () => {
    const rows = awaited('rows');
    expect(modelShape(checker, rows)).to.deep.equal({ model: 'Post', shape: 'many' });
    const element = elementOf(rows);
    expect(element.isIntersection()).to.equal(true);
    const owner = memberType(element, 'Owner');
    expect(owner.isIntersection()).to.equal(true);
    const relation = relationOf(checker, owner);
    expect(relation !== undefined && extendsFrameworkClass(checker, relation, 'SingleRelation', '@spinajs/orm')).to.equal(true);
    expect(nameOf(modelOf(checker, memberType(owner, 'Value')))).to.equal('User');
  });

  it("first() after populate('Owner') is one Post", () => {
    expect(modelShape(checker, awaited('row'))).to.deep.equal({ model: 'Post', shape: 'one' });
  });

  it("populate('Tags') narrows a Relation, still read as a relation", () => {
    const tags = memberType(elementOf(awaited('tagRows')), 'Tags');
    expect(tags.isIntersection()).to.equal(true);
    const relation = relationOf(checker, tags);
    expect(relation !== undefined && extendsFrameworkClass(checker, relation, 'Relation', '@spinajs/orm')).to.equal(true);
  });

  it('the builder populate() returns is no row, but the flow pass reads its model', () => {
    expect(modelShape(checker, returned('builder'))).to.equal(undefined);
    expect(buildersOf(checker, returned('builder'))).to.deep.equal([{ kind: 'select', model: 'Post' }]);
  });
});
