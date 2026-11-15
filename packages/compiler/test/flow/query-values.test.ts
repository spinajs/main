import { expect } from 'chai';
import ts from 'typescript';
import { createProgramFromTsconfig, iterationsOver, traceQueryValues } from '../../src/index.js';

describe('flow: traceQueryValues and iterationsOver', () => {
  const loaded = createProgramFromTsconfig('test/fixtures/pkg-n-plus-one/tsconfig.json');
  const file = loaded.sourceFiles.find((f) => f.fileName.endsWith('flow.ts'));
  const body = (name: string): ts.Block => {
    const fn = file?.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (!fn?.body) throw new Error(`no function ${name} in flow.ts`);
    return fn.body;
  };
  const summary = (name: string): unknown[] =>
    [...traceQueryValues(body(name), loaded.checker)].map(([symbol, v]) => ({ name: symbol.name, model: v.model, shape: v.shape, populated: [...v.populated].sort(), scoped: v.scoped }));

  it('follows await, populate with a nested callback, scoping calls and array destructuring', () => {
    const owner = ['Owner', 'Owner.Company'];
    expect(summary('scoped')).to.deep.equal([
      { name: 'posts', model: 'Post', shape: 'many', populated: owner, scoped: { accessible: true, unscoped: false } },
      { name: 'first', model: 'Post', shape: 'one', populated: [], scoped: { accessible: false, unscoped: true } },
      { name: 'head', model: 'Post', shape: 'one', populated: owner, scoped: { accessible: true, unscoped: false } },
      { name: 'tail', model: 'Post', shape: 'many', populated: owner, scoped: { accessible: true, unscoped: false } },
    ]);
  });

  it('follows a builder variable that a later statement extends', () => {
    expect(summary('builder')).to.deep.equal([{ name: 'posts', model: 'Post', shape: 'many', populated: ['Tags'], scoped: { accessible: false, unscoped: false } }]);
  });

  it('finds for…of, forEach, map inside Promise.all, and reduce over one value', () => {
    const block = body('loops');
    const posts = [...traceQueryValues(block, loaded.checker).keys()].find((s) => s.name === 'posts');
    if (!posts) throw new Error('posts not traced');
    expect(iterationsOver(block, posts, loaded.checker).map((i) => [ts.SyntaxKind[i.loop.kind], i.item?.name])).to.deep.equal([
      ['ForOfStatement', 'p'],
      ['CallExpression', 'q'],
      ['CallExpression', 'r'],
      ['CallExpression', 's'],
    ]);
  });
});
