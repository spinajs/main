import { expect } from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANIFEST_VERSION, manifestSchema, validateFragment, validateManifest } from '../src/index.js';
// @ts-expect-error plain ESM script without declarations
import { generate } from '../scripts/generate-schema.mjs';

const file = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

describe('manifest types and schema', () => {
  it('pins manifest version 1', () => {
    expect(MANIFEST_VERSION).to.equal(1);
  });

  it('committed schema.json matches a fresh generation from types.ts', function () {
    this.timeout(60000);
    expect(JSON.parse(readFileSync(file('../src/schema.json'), 'utf8'))).to.deep.equal(generate());
  });

  it('schema.ts mirrors schema.json', () => {
    expect(manifestSchema).to.deep.equal(JSON.parse(readFileSync(file('../src/schema.json'), 'utf8')));
  });

  it('accepts the minimal fixture', () => {
    expect(validateManifest(JSON.parse(readFileSync(file('./fixtures/minimal.manifest.json'), 'utf8')))).to.deep.equal([]);
  });

  it('rejects a manifest that lacks required members', () => {
    expect(validateManifest({ manifestVersion: 1 })).to.not.be.empty;
    expect(validateFragment({ manifestVersion: 1 })).to.not.be.empty;
  });
});
