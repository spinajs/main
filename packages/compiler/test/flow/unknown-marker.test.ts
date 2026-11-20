import { expect } from 'chai';
import ts from 'typescript';
import { builderOf, createProgramFromTsconfig } from '../../src/index.js';

describe('flow: an unknown @spinajs query value', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/unknown-marker/tsconfig.json');
  const { checker } = loaded;

  it('fails the analysis, naming the file and line of the declaration that carries it, the value and the allowed ones', () => {
    const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('/src/index.ts'))!;
    let below: ts.VariableDeclaration | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.name.getText() === 'below') below = node;
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(() => builderOf(checker, checker.getTypeAtLocation(below!))).to.throw(
      /unknown-marker\/src\/index\.ts:2: @spinajs query: unknown value 'selct' \(expected select, update, delete or insert\)/,
    );
  });
});
