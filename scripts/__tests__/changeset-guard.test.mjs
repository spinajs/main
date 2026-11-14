import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivatePackage, requiresChangeset } from '../changeset-guard.mjs';

test('package src change without a changeset requires one', () => {
  assert.equal(requiresChangeset(['packages/http/src/index.ts']), true);
});

test('package src change with an added changeset does not require one', () => {
  assert.equal(requiresChangeset(['packages/http/src/index.ts', '.changeset/brave-lions-jump.md']), false);
});

test('tests, docs, scripts and workflows alone do not require a changeset', () => {
  assert.equal(
    requiresChangeset(['packages/http/test/a.test.ts', 'docs/http/readme.md', 'scripts/x.mjs', '.github/workflows/build.yml', 'packages/http/package.json']),
    false,
  );
});

test('.changeset README and config are not changesets', () => {
  assert.equal(requiresChangeset(['packages/di/src/a.ts', '.changeset/README.md', '.changeset/config.json']), true);
});

test('nested src paths and windows separators count', () => {
  assert.equal(requiresChangeset(['packages\\orm\\src\\deep\\a.ts']), true);
});

test('empty diff requires nothing', () => {
  assert.equal(requiresChangeset([]), false);
});

test('a deleted changeset does not satisfy the guard', () => {
  assert.equal(requiresChangeset([{ path: 'packages/di/src/a.ts', status: 'M' }, { path: '.changeset/old.md', status: 'D' }]), true);
  assert.equal(requiresChangeset([{ path: 'packages/di/src/a.ts', status: 'M' }, { path: '.changeset/new.md', status: 'A' }]), false);
});

test('a private package needs no changeset; a published package next to it still does', () => {
  const privateOnly = (name) => name === 'orm-conformance';
  assert.equal(requiresChangeset(['packages/orm-conformance/src/index.ts', 'packages/orm-conformance/cases/a.case.ts'], privateOnly), false);
  assert.equal(requiresChangeset(['packages/orm-conformance/src/index.ts', 'packages/orm/src/a.ts'], privateOnly), true);
});

test('isPrivatePackage reads "private" from the package.json under packages/', () => {
  assert.equal(isPrivatePackage('orm-conformance'), true);
  assert.equal(isPrivatePackage('orm'), false);
  assert.equal(isPrivatePackage('no-such-package'), false);
});
