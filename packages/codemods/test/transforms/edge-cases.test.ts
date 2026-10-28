import { expect } from 'chai';
import { Project } from 'ts-morph';
import { V4_TRANSFORMS } from '../../src/index.js';

function run(name: string, source: string, fileName = 'input.ts') {
  const transform = V4_TRANSFORMS.find((t) => t.name === name)!;
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { experimentalDecorators: true, allowJs: true } });
  const file = project.createSourceFile(fileName, source);
  const warnings: string[] = [];
  const changed = transform.apply(project, file, (_node, message) => warnings.push(message));
  return { changed, text: file.getFullText(), warnings };
}

describe('esm-module-support edge cases', () => {
  it('replaces a setESMModuleSupport call that is the sole statement of an if/else', () => {
    const { text } = run('esm-module-support', 'if (x) DI.setESMModuleSupport(); else foo();\nwhile (y) DI.setESMModuleSupport();\n');
    expect(text).to.equal('if (x) {} else foo();\nwhile (y) {}\n');
  });

  it('still removes the call inside a block', () => {
    const { text } = run('esm-module-support', 'function f() {\n  DI.setESMModuleSupport();\n  return 1;\n}\n');
    expect(text).to.not.contain('setESMModuleSupport');
  });

  it('resolves probe variables by scope, not by name', () => {
    const { text } = run(
      'esm-module-support',
      "const m = typeof module !== 'undefined';\nexport function f(m: boolean) { return m ? 'a' : 'b'; }\nexport const g = m ? 'x' : 'y';\n",
    );
    expect(text).to.contain("return m ? 'a' : 'b';");
    expect(text).to.contain("export const g = 'y';");
    expect(text).to.not.contain('typeof module');
  });

  it('leaves a same-named local alone when the probe is not used', () => {
    const { text } = run('esm-module-support', "const m = typeof module !== 'undefined';\nexport function f(m: boolean) { return m ? 'a' : 'b'; }\n");
    expect(text).to.contain("return m ? 'a' : 'b';");
  });

  it('does not produce an absolute path from an empty segment in a template or concatenation', () => {
    const template = "export const a = `${typeof module !== 'undefined' ? 'cjs' : 'mjs'}/x`;\n";
    const concat = "export const b = (typeof module !== 'undefined' ? 'cjs' : 'mjs') + '/x';\n";
    for (const source of [template, concat]) {
      const { text, warnings } = run('esm-module-support', source);
      expect(text).to.equal(source);
      expect(warnings).to.have.length(1);
    }
  });

  it('recognises a parenthesised probe', () => {
    const { text } = run('esm-module-support', "export const a = (typeof module !== 'undefined') ? 'x' : 'y';\n");
    expect(text).to.equal("export const a = 'y';\n");
  });
});

describe('lib-mjs-imports edge cases', () => {
  it('rewrites require, import = require, typeof import() and template import()', () => {
    const { text } = run(
      'lib-mjs-imports',
      "const a = require('@spinajs/http/lib/mjs/index.js');\nimport b = require('@spinajs/http/lib/mjs/index.js');\ntype T = typeof import('@spinajs/http/lib/mjs/index.js');\nconst c = import(`@spinajs/http/lib/mjs/index.js`);\n",
    );
    expect(text).to.not.contain('lib/mjs');
    expect(text.match(/@spinajs\/http['`]/g)).to.have.length(4);
  });

  it('reports lib/cjs leftovers and leaves them', () => {
    const { text, warnings, changed } = run('lib-mjs-imports', "import x from '@spinajs/http/lib/cjs/index.js';\n");
    expect(changed).to.equal(true);
    expect(text).to.contain("from '@spinajs/http/lib/cjs/index.js'");
    expect(text).to.contain('TODO(spinajs-4)');
    expect(warnings).to.have.length(1);
  });

  it('leaves a deep path whose root cannot be checked and reports it', () => {
    const { text, warnings } = run('lib-mjs-imports', "import '@spinajs/orm/lib/mjs/config/orm.js';\nimport { Z } from '@spinajs/orm/lib/mjs/z.js';\n");
    expect(text).to.contain("import '@spinajs/orm/lib/mjs/config/orm.js'");
    expect(text).to.contain("from '@spinajs/orm/lib/mjs/z.js'");
    expect(warnings).to.have.length(2);
  });

  it('is idempotent on leftovers', () => {
    const first = run('lib-mjs-imports', "import '@spinajs/orm/lib/mjs/config/orm.js';\n");
    const second = run('lib-mjs-imports', first.text);
    expect(second.changed).to.equal(false);
    expect(second.text).to.equal(first.text);
  });
});
