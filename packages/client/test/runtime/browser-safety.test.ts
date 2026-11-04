import 'mocha';
import { expect } from 'chai';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runtimeDir = fileURLToPath(new URL('../../src/runtime/', import.meta.url));
const SPECIFIER = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;

describe('@spinajs/client/runtime browser safety', () => {
  it('imports nothing outside its own directory', () => {
    const outside: string[] = [];
    for (const file of readdirSync(runtimeDir).filter((name) => name.endsWith('.ts'))) {
      for (const match of readFileSync(runtimeDir + file, 'utf8').matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (!/^\.\/[\w.-]+\.js$/.test(specifier)) outside.push(`${file}: ${specifier}`);
      }
    }
    expect(outside).to.deep.equal([]);
  });
});
