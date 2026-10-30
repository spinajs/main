import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addManifestField, manifestInFiles } from '../manifest-field.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyManifestField, applyManifestFields } from '../migrate-esm-only.mjs';

test('addManifestField adds the fragment path and keeps other spinajs keys', () => {
  assert.deepEqual(addManifestField({ name: 'a' }), { name: 'a', spinajs: { manifest: 'lib/manifest.fragment.json' } });
  assert.deepEqual(addManifestField({ name: 'a', spinajs: { x: 1 } }).spinajs, { x: 1, manifest: 'lib/manifest.fragment.json' });
});

test('addManifestField is idempotent', () => {
  const once = addManifestField({ name: 'a' });
  assert.equal(addManifestField(once), once);
});

test('manifestInFiles understands lib globs and rejects other roots', () => {
  assert.equal(manifestInFiles({ files: ['lib/**/*'] }), true);
  assert.equal(manifestInFiles({ files: ['lib'] }), true);
  assert.equal(manifestInFiles({ files: ['./lib/'] }), true);
  assert.equal(manifestInFiles({ files: ['lib/manifest.fragment.json'] }), true);
  assert.equal(manifestInFiles({ files: ['dist/**/*'] }), false);
  assert.equal(manifestInFiles({ files: ['lib/index.js'] }), false);
  assert.equal(manifestInFiles({}), true);
});

test('applyManifestField targets only packages with sources to analyze', () => {
  assert.equal(applyManifestField({ name: 'a' }, { analyzable: false }).spinajs, undefined);
  assert.equal(applyManifestField({ name: 'a' }, { analyzable: true }).spinajs.manifest, 'lib/manifest.fragment.json');
});

test('--manifest-field skips packages without src/ or tsconfig.build.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'manifest-field-'));
  try {
    const make = (name, { src, tsconfig }) => {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
      if (src) mkdirSync(join(dir, 'src'));
      if (tsconfig) writeFileSync(join(dir, 'tsconfig.build.json'), '{}');
    };
    make('full', { src: true, tsconfig: true });
    make('no-src', { src: false, tsconfig: true });
    make('no-tsconfig', { src: true, tsconfig: false });
    applyManifestFields(false, root);
    const read = (name) => JSON.parse(readFileSync(join(root, name, 'package.json'), 'utf8'));
    assert.equal(read('full').spinajs.manifest, 'lib/manifest.fragment.json');
    assert.equal(read('no-src').spinajs, undefined);
    assert.equal(read('no-tsconfig').spinajs, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
