import 'mocha';
import { expect } from 'chai';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvedTypeRef, resolveTypeRef } from '../src/runtime-types.js';
import { ManifestMissing } from '../src/runtime.js';
import type { Manifest } from '../src/index.js';

const FIX = resolve(process.cwd(), 'test', 'fixtures', 'runtime');

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

const manifest = (): Manifest => JSON.parse(readFileSync(resolve(FIX, 'app.manifest.json'), 'utf8')) as Manifest;

describe('resolveTypeRef', () => {
  it('returns the global constructor for a global ref', async () => {
    expect(await resolveTypeRef({ package: 'global', file: '', export: 'Number' }, manifest(), FIX)).to.equal(Number);
    expect(await resolveTypeRef({ package: 'global', file: '', export: 'Date' }, manifest(), FIX)).to.equal(Date);
  });

  it('imports a package ref through the manifest file mapping', async () => {
    const { A } = (await import(pathToFileURL(resolve(FIX, 'lib/controllers/A.js')).href)) as { A: unknown };
    const found = await resolveTypeRef({ package: 'runtime-fixture', file: 'src/controllers/A.ts', export: 'A' }, manifest(), FIX);
    expect(found).to.equal(A);
  });

  it('remembers what it resolved, per manifest', async () => {
    const m = manifest();
    const ref = { package: 'runtime-fixture', file: 'src/controllers/A.ts', export: 'A' };
    expect(resolvedTypeRef(ref, m)).to.equal(undefined);
    const found = await resolveTypeRef(ref, m, FIX);
    expect(resolvedTypeRef(ref, m)).to.equal(found);
    expect(resolvedTypeRef(ref, manifest())).to.equal(undefined);
  });

  it('refuses a file that leaves the package root', async () => {
    const escaping = { package: 'runtime-fixture', file: '../../outside.ts', export: 'A' };
    const err = await rejection(resolveTypeRef(escaping, manifest(), FIX));
    expect(err).to.be.instanceOf(ManifestMissing);
    expect(err.message).to.match(/leaves the root/);
  });

  it('names the export when the module lacks it, and unknown globals', async () => {
    const missing = await rejection(resolveTypeRef({ package: 'runtime-fixture', file: 'src/controllers/A.ts', export: 'B' }, manifest(), FIX));
    expect(missing).to.be.instanceOf(ManifestMissing);
    expect(missing.message).to.match(/does not export B/);
    expect((await rejection(resolveTypeRef({ package: 'global', file: '', export: 'NoSuchGlobal' }, manifest(), FIX))).message).to.match(/NoSuchGlobal/);
  });
});
