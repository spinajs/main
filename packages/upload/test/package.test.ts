import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* eslint-disable security/detect-non-literal-fs-filename -- this package's own manifest, src and build */
const read = (file: string): string => readFileSync(file, 'utf8');
const present = (file: string): boolean => existsSync(file);
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
/* eslint-enable security/detect-non-literal-fs-filename */

// from '…', require('…') and import('…'), in either quote style.
const REFERENCE = /['"]@spinajs\/scheduler['"]/;

const manifest =JSON.parse(read(join(ROOT, 'package.json'))) as Record<string, Record<string, unknown>>;

describe('@spinajs/upload package', () => {
  it('imports @spinajs/scheduler only from the ./scheduler subpath', () => {
    const importers = sources(join(ROOT, 'src'))
      .filter((file) => REFERENCE.test(read(file)))
      .map((file) => relative(ROOT, file).replace(/\\/g, '/'));
    expect(importers).to.deep.equal(['src/scheduler.ts']);
  });

  it('has no @spinajs/scheduler reference in the built entry points', () => {
    for (const build of ['mjs', 'cjs']) {
      const entry = join(ROOT, 'lib', build, 'index.js');
      expect(present(entry), entry).to.eq(true);
      expect(read(entry), entry).to.not.match(REFERENCE);
    }
  });

  it('declares @spinajs/scheduler as an optional peer, not as a dependency', () => {
    expect(manifest.dependencies).to.not.have.property('@spinajs/scheduler');
    expect(manifest.peerDependencies).to.include({ '@spinajs/scheduler': '3.0.16' });
    expect(manifest.peerDependenciesMeta).to.deep.include({ '@spinajs/scheduler': { optional: true } });
    expect(manifest.devDependencies).to.include({ '@spinajs/scheduler': '3.0.16' });
  });

  it('depends on @spinajs/cli for the upload:sweep command', () => {
    expect(manifest.dependencies).to.include({ '@spinajs/cli': '3.0.16' });
  });

  it('exports ./scheduler from both builds', () => {
    expect(manifest.exports['./scheduler']).to.deep.equal({ types: './lib/mjs/scheduler.d.ts', import: './lib/mjs/scheduler.js', require: './lib/cjs/scheduler.js' });
    expect(manifest.typesVersions).to.deep.equal({ '*': { scheduler: ['lib/cjs/scheduler.d.ts'] } });
  });

  it('resolves @spinajs/upload/scheduler to the built module', () => {
    const file = fileURLToPath(import.meta.resolve('@spinajs/upload/scheduler'));
    expect(file.replace(/\\/g, '/')).to.match(/\/packages\/upload\/lib\/mjs\/scheduler\.js$/);
    expect(present(file)).to.eq(true);
  });
});
