import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/* eslint-disable security/detect-non-literal-fs-filename -- this package's own manifest, src and build */
const read = (file: string): string => readFileSync(file, 'utf8');
const present = (file: string): boolean => existsSync(file);
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
/* eslint-enable security/detect-non-literal-fs-filename */

const REFERENCE = /['"]@spinajs\/(http|validation)['"]/;
const rel = (file: string): string => relative(ROOT, file).replace(/\\/g, '/');

const manifest = JSON.parse(read(join(ROOT, 'package.json'))) as Record<string, Record<string, unknown>>;
// Internal pins follow the lockstep version, which bump-all.mjs moves on every release.
const VERSION = manifest.version as unknown as string;

describe('@spinajs/upload/http packaging', () => {
  it('exports the controller from the ./http subpath', () => {
    expect(manifest.exports['./http']).to.deep.equal({ types: './lib/http/index.d.ts', import: './lib/http/index.js' });
    expect(manifest.typesVersions).to.deep.include({ '*': { scheduler: ['lib/scheduler.d.ts'], http: ['lib/http/index.d.ts'] } });
  });

  it('imports @spinajs/http and @spinajs/validation only from src/http', () => {
    const importers = sources(join(ROOT, 'src'))
      .filter((file) => REFERENCE.test(read(file)))
      .map(rel);
    expect(importers).to.not.be.empty;
    for (const file of importers) expect(file, file).to.match(/^src\/http\//);
  });

  it('has no @spinajs/http or @spinajs/validation reference in the built main entry', () => {
    const entry = join(ROOT, 'lib', 'index.js');
    expect(present(entry), entry).to.eq(true);
    expect(read(entry), entry).to.not.match(REFERENCE);
    expect(read(entry), entry).to.not.match(/\.\/http\//);
    expect(read(join(ROOT, 'src', 'index.ts'))).to.not.match(/http\//);
  });

  it('declares @spinajs/http and @spinajs/validation as optional peers, not as dependencies', () => {
    expect(manifest.dependencies).to.not.have.any.keys('@spinajs/http', '@spinajs/validation');
    expect(manifest.peerDependencies).to.include({ '@spinajs/http': VERSION, '@spinajs/validation': VERSION });
    expect(manifest.peerDependenciesMeta).to.deep.include({ '@spinajs/http': { optional: true }, '@spinajs/validation': { optional: true } });
    expect(manifest.devDependencies).to.include({ '@spinajs/http': VERSION, '@spinajs/validation': VERSION });
  });
});
