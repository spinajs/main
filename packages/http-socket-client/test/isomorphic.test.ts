import 'mocha';
import { expect } from 'chai';
import { builtinModules } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const ALLOWED_PACKAGES = ['@spinajs/http-socket-common', 'socket.io-client'];
const NODE_GLOBAL = /\b(?:process|Buffer|__dirname|__filename|require|setImmediate|global)\s*[.(]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)) {
    found.push(match[1] ?? match[2]);
  }
  return found;
}

describe('isomorphic main entry', () => {
  it('declares only socket.io-client and http-socket-common as runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).to.deep.equal(ALLOWED_PACKAGES);
  });

  it('src imports only relative modules and the allowed packages, and uses no Node globals', () => {
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const files = sourceFiles(join(packageDir, 'src'));
    expect(files).to.not.be.empty;

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of specifiers(source)) {
        expect(builtins.has(specifier), `${file} imports Node built-in ${specifier}`).to.equal(false);
        expect(specifier.startsWith('.') || ALLOWED_PACKAGES.includes(specifier), `${file} imports ${specifier}`).to.equal(true);
      }
      expect(NODE_GLOBAL.test(source), `${file} uses a Node global`).to.equal(false);
    }
  });
});
