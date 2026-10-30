import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addManifestField, manifestInFiles } from '../manifest-field.mjs';
import { applyManifestField } from '../migrate-esm-only.mjs';

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
