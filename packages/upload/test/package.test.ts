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

const manifest = JSON.parse(read(join(ROOT, 'package.json'))) as Record<string, Record<string, unknown>>;
// Internal pins follow the lockstep version, which bump-all.mjs moves on every release.
const VERSION = manifest.version as unknown as string;

describe('@spinajs/upload package', () => {
  it('imports @spinajs/scheduler only from the ./scheduler subpath', () => {
    const importers = sources(join(ROOT, 'src'))
      .filter((file) => REFERENCE.test(read(file)))
      .map((file) => relative(ROOT, file).replace(/\\/g, '/'));
    expect(importers).to.deep.equal(['src/scheduler.ts']);
  });

  it('has no @spinajs/scheduler reference in the built entry points', () => {
    const entry = join(ROOT, 'lib', 'index.js');
    expect(present(entry), entry).to.eq(true);
    expect(read(entry), entry).to.not.match(REFERENCE);
  });

  it('declares @spinajs/scheduler as an optional peer, not as a dependency', () => {
    expect(manifest.dependencies).to.not.have.property('@spinajs/scheduler');
    expect(manifest.peerDependencies).to.include({ '@spinajs/scheduler': VERSION });
    expect(manifest.peerDependenciesMeta).to.deep.include({ '@spinajs/scheduler': { optional: true } });
    expect(manifest.devDependencies).to.include({ '@spinajs/scheduler': VERSION });
  });

  it('depends on @spinajs/cli for the upload:sweep command', () => {
    expect(manifest.dependencies).to.include({ '@spinajs/cli': VERSION });
  });

  it('exports ./scheduler', () => {
    expect(manifest.exports['./scheduler']).to.deep.equal({ types: './lib/scheduler.d.ts', import: './lib/scheduler.js' });
    expect(manifest.typesVersions).to.deep.include({ '*': { scheduler: ['lib/scheduler.d.ts'], http: ['lib/http/index.d.ts'] } });
  });

  it('resolves @spinajs/upload/scheduler to the built module', () => {
    const file = fileURLToPath(import.meta.resolve('@spinajs/upload/scheduler'));
    expect(file.replace(/\\/g, '/')).to.match(/\/packages\/upload\/lib\/scheduler\.js$/);
    expect(present(file)).to.eq(true);
  });

  it('keeps internal helpers out of the main entry, and the documented services in it', async () => {
    const root = (await import('../src/index.js')) as Record<string, unknown>;
    expect(root).to.not.have.any.keys('HeadCapture', 'closed', 'loadFileType', 'finalEventOf', 'PURGED_STATUSES', 'toStateView', 'isoOf');
    expect(root).to.include.keys('UploadService', 'UploadStorage', 'UploadStore', 'UploadEvents', 'UploadSweeper', 'ContentTypeCheck', 'ContentDetector', 'parseDuration', 'DURATION_PATTERN');
  });
});
