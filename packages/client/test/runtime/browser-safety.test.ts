import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const runtimeDir = fileURLToPath(new URL('../../src/runtime/', import.meta.url));
const SPECIFIER = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
// The root tsconfig loads @types/node, so these would compile in the runtime and then fail in a browser.
const NODE_GLOBALS = new Set(['Buffer', 'process', 'require', 'module', 'exports', 'global', '__dirname', '__filename', 'setImmediate', 'clearImmediate']);
const GLOBAL_OBJECTS = new Set(['globalThis', 'window', 'self']);

const sources = (): [string, string][] => readdirSync(runtimeDir).filter((name) => name.endsWith('.ts')).map((name) => [name, readFileSync(runtimeDir + name, 'utf8')]);

const isGlobalObject = (node: ts.Expression): boolean => ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);

function isGlobalReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return isGlobalObject(parent.expression);
  const isMemberName = ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent);
  return !(isMemberName && parent.name === node);
}

/** Walks the syntax tree, so comments, strings and regex literals cannot hide or fake a use. */
function nodeGlobals(file: string, code: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NODE_GLOBALS.has(node.text) && isGlobalReference(node)) found.push(`${file}: ${node.text}`);
    if (ts.isElementAccessExpression(node) && isGlobalObject(node.expression) && ts.isStringLiteral(node.argumentExpression) && NODE_GLOBALS.has(node.argumentExpression.text)) {
      found.push(`${file}: ${node.argumentExpression.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true));
  return found;
}

describe('@spinajs/client/runtime browser safety', () => {
  it('imports nothing outside its own directory', () => {
    const outside: string[] = [];
    for (const [file, code] of sources()) {
      for (const match of code.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (!/^\.\/[\w.-]+\.js$/.test(specifier)) outside.push(`${file}: ${specifier}`);
      }
    }
    expect(outside).to.deep.equal([]);
  });

  it('uses no Node global', () => {
    expect(sources().flatMap(([file, code]) => nodeGlobals(file, code))).to.deep.equal([]);
  });

  it('finds Node globals behind globalThis, after a URL string and past a quote in a regex', () => {
    const sample = [
      `const a = globalThis.process.env;`,
      `const b = globalThis['Buffer'];`,
      `const url = 'http://example.com'; const c = Buffer.from(url);`,
      `const re = /['"\`]/; const d = setImmediate;`,
      `// process.env in a comment`,
      `const e = { process: 1, global: 2 }; const f = e.process; const s = 'require("x")';`,
    ].join('\n');
    expect(nodeGlobals('sample.ts', sample).map((hit) => hit.slice('sample.ts: '.length))).to.deep.equal(['process', 'Buffer', 'Buffer', 'setImmediate']);
  });
});
