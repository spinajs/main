import { expect } from 'chai';
import 'mocha';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '../src/index.js';
import { ManifestValidationError, ManifestVersionError, readFragment, readManifest } from '../src/index.js';
import { fragment } from './support.js';

const appBasic = fileURLToPath(new URL('../../compiler/test/fixtures/app-basic/app.manifest.json', import.meta.url));
const minimal = fileURLToPath(new URL('./fixtures/minimal.manifest.json', import.meta.url));

function tmpJson(value: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), 'manifest-')), 'm.json');
  writeFileSync(file, JSON.stringify(value));
  return file;
}

async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('readManifest / readFragment', () => {
  it('reads a valid manifest', async () => {
    const m = await readManifest(minimal);
    expect(m.app.name).to.equal('demo-app');
  });

  it('rejects manifestVersion 3 with ManifestVersionError', async () => {
    const bad = { ...JSON.parse(readFileSync(minimal, 'utf8')), manifestVersion: 3 };
    const err = await failure(readManifest(tmpJson(bad)));
    expect(err).to.be.instanceOf(ManifestVersionError);
    expect((err as ManifestVersionError).found).to.equal(3);
  });

  it('rejects a version 1 fragment, whose fullPath and kind values mean something else', async () => {
    const err = await failure(readFragment(tmpJson({ ...fragment('a'), manifestVersion: 1 })));
    expect(err).to.be.instanceOf(ManifestVersionError);
    expect((err as ManifestVersionError).found).to.equal(1);
  });

  it('reports the JSON path of a structural violation', async () => {
    const bad = JSON.parse(readFileSync(minimal, 'utf8')) as Manifest;
    (bad.app as unknown as { name: unknown }).name = 5;
    const err = await failure(readManifest(tmpJson(bad)));
    expect(err).to.be.instanceOf(ManifestValidationError);
    expect((err as ManifestValidationError).errors.join('\n')).to.contain('$.app.name');
  });

  it('rejects a missing required array', async () => {
    const bad = JSON.parse(readFileSync(minimal, 'utf8')) as Manifest;
    delete (bad as Partial<Manifest>).services;
    expect(await failure(readManifest(tmpJson(bad)))).to.be.instanceOf(ManifestValidationError);
  });

  it('ignores unknown fields', async () => {
    const m = { ...JSON.parse(readFileSync(minimal, 'utf8')), future: { a: 1 } };
    expect((await readManifest(tmpJson(m))).app.name).to.equal('demo-app');
  });

  it('ignores unknown nested fields', async () => {
    const m = JSON.parse(readFileSync(minimal, 'utf8')) as { app: Record<string, unknown> };
    m.app.future = { a: 1 };
    expect((await readManifest(tmpJson(m))).app.name).to.equal('demo-app');
  });

  it('reads the compiler app-basic fixture under Ajv strict mode', async () => {
    const m = await readManifest(appBasic);
    expect(m.manifestVersion).to.equal(2);
  });

  it('reports a missing required property with its path', async () => {
    const bad = JSON.parse(readFileSync(minimal, 'utf8')) as Manifest;
    delete (bad.app as Partial<Manifest['app']>).name;
    const err = (await failure(readManifest(tmpJson(bad)))) as ManifestValidationError;
    expect(err.errors).to.include('$.app.name: required');
  });

  it('validates enum members', async () => {
    const f = fragment('a', {
      services: [{ id: 's', className: 's', registeredAs: [], lifetime: 'forever' as never, async: false, bootstrapper: false, ctorInjects: [], propertyInjects: [], source: { file: 'f', line: 1, col: 1, package: 'a' } }],
    });
    expect(await failure(readFragment(tmpJson(f)))).to.be.instanceOf(ManifestValidationError);
  });
});
