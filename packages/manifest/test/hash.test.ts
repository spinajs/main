import { expect } from 'chai';
import 'mocha';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalize, hashManifest } from '../src/index.js';
import type { Manifest } from '../src/index.js';

const minimal: Manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/minimal.manifest.json', import.meta.url)), 'utf8'));

describe('canonicalize / hashManifest', () => {
  it('sorts keys and emits no whitespace', () => {
    expect(canonicalize({ b: 1, a: [{ d: 2, c: 3 }] })).to.equal('{"a":[{"c":3,"d":2}],"b":1}');
  });

  it('drops undefined object members like JSON.stringify', () => {
    expect(canonicalize({ a: undefined, b: 1 })).to.equal('{"b":1}');
  });

  it('is stable across key order', () => {
    const reordered = Object.fromEntries(Object.entries(minimal).reverse()) as unknown as Manifest;
    expect(hashManifest(reordered)).to.equal(hashManifest(minimal));
  });

  it('ignores generatedAt and the stored hash', () => {
    const other = { ...minimal, generatedAt: '2030-05-05T00:00:00.000Z', hash: 'whatever' };
    expect(hashManifest(other)).to.equal(hashManifest(minimal));
  });

  it('changes when content changes', () => {
    const other = { ...minimal, app: { ...minimal.app, version: '2.0.0' } };
    expect(hashManifest(other)).to.not.equal(hashManifest(minimal));
  });

  it('returns a sha256 hex digest', () => {
    expect(hashManifest(minimal)).to.match(/^[0-9a-f]{64}$/);
  });
});
