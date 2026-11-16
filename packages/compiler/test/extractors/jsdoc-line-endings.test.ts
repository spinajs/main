import { expect } from 'chai';
import ts from 'typescript';
import type { ExtractorContext } from '../../src/context.js';
import { classDocOf, routeDocOf } from '../../src/extractors/jsdoc.js';

const ctx = { info: () => undefined } as unknown as ExtractorContext;

function classOf(source: string): ts.ClassDeclaration {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  return file.statements.find(ts.isClassDeclaration)!;
}

describe('JSDoc text', () => {
  const lines = ['/**', ' * First line', ' * second line.', ' * @description Body', ' * over two lines', ' */'];
  const source = (eol: string) => [...lines, 'class Items {', ...lines.map((l) => `  ${l}`), '  list() {}', '}'].join(eol);

  it('reads a CRLF file as the LF one, so the manifest hash does not depend on the checkout', () => {
    for (const eol of ['\n', '\r\n']) {
      const cls = classOf(source(eol));
      expect(classDocOf(cls), JSON.stringify(eol)).to.equal('First line\nsecond line.');
      expect(routeDocOf(cls.members.find(ts.isMethodDeclaration)!, ctx), JSON.stringify(eol)).to.deep.equal({ description: 'Body\nover two lines' });
    }
  });
});
