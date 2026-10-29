import { expect } from 'chai';
import ts from 'typescript';
import { analyzePackage, createContext, createProgramFromTsconfig } from '../src/index.js';

const HTTP_TSCONFIG = '../http/tsconfig.mjs.json';

describe('exit check: packages/http analyzes cleanly', function () {
  this.timeout(60000);

  it('0 error diagnostics and controllers == BaseController subclasses in src', async () => {
    const started = Date.now();
    const fragment = await analyzePackage({ tsconfig: HTTP_TSCONFIG, packageRoot: '../http' });
    const elapsed = Date.now() - started;
    console.log(`      packages/http analysis: ${elapsed} ms`);
    expect(elapsed).to.be.below(20000);
    expect(fragment.diagnostics.filter((d) => d.severity === 'error')).to.deep.equal([]);

    const loaded = createProgramFromTsconfig(HTTP_TSCONFIG);
    const ctx = createContext(loaded, '@spinajs/http', '../http');
    let expected = 0;
    const walk = (n: ts.Node): void => {
      if (ts.isClassDeclaration(n) && n.name && ctx.isSubclassOf(n, 'BaseController')) expected++;
      ts.forEachChild(n, walk);
    };
    loaded.sourceFiles.forEach((f) => walk(f));
    expect(fragment.services.length, 'analysis saw the package source').to.be.greaterThan(0);
    expect(fragment.controllers).to.have.length(expected);
  });
});
