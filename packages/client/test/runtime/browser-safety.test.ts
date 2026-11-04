import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runtimeDir = fileURLToPath(new URL('../../src/runtime/', import.meta.url));
const SPECIFIER = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;
// The root tsconfig loads @types/node, so these would compile in the runtime and then fail in a browser.
const NODE_GLOBAL = /(?<![\w.$])(Buffer|process|require|module|exports|global|__dirname|__filename|setImmediate|clearImmediate)\b(?!\s*:)/g;

const sources = (): [string, string][] => readdirSync(runtimeDir).filter((name) => name.endsWith('.ts')).map((name) => [name, readFileSync(runtimeDir + name, 'utf8')]);

const withoutCommentsAndStrings = (code: string): string => code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");

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
    const found = sources().flatMap(([file, code]) => [...withoutCommentsAndStrings(code).matchAll(NODE_GLOBAL)].map((match) => `${file}: ${match[1]}`));
    expect(found).to.deep.equal([]);
  });
});
