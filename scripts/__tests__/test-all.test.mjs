import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { selectPackages, summarize, loadKnownFailing } from '../test-all.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

test('selectPackages skips local-only under ci', () => {
  const pkgs = selectPackages({ ci: true, root });
  assert.ok(pkgs.length > 50);
  assert.ok(!pkgs.includes('fs-s3'));
  assert.ok(selectPackages({ ci: false, root }).includes('fs-s3'));
});

test('selectPackages honours only', () => {
  assert.deepEqual(selectPackages({ ci: true, root, only: ['di', 'exceptions'] }).sort(), ['di', 'exceptions']);
});

test('summarize exits non-zero when a package failed', () => {
  const { exitCode, lines } = summarize([{ name: 'di', ok: true, seconds: 1 }, { name: 'http', ok: false, seconds: 2 }]);
  assert.equal(exitCode, 1);
  assert.match(lines.join('\n'), /http.*failed/);
});

test('summarize treats a failing known-failing package as a warning', () => {
  const { exitCode, lines } = summarize(
    [{ name: 'di', ok: true, seconds: 1 }, { name: 'fs', ok: false, seconds: 2 }],
    new Set(['fs']),
  );
  assert.equal(exitCode, 0);
  const text = lines.join('\n');
  assert.match(text, /WARNING.*fs.*known-failing/);
  assert.doesNotMatch(text, /^fss+failed/m);
});

test('summarize still fails on an unlisted failure next to a known one', () => {
  const { exitCode } = summarize([{ name: 'fs', ok: false, seconds: 1 }, { name: 'http', ok: false, seconds: 1 }], new Set(['fs']));
  assert.equal(exitCode, 1);
});

test('summarize asks to remove a passing known-failing package', () => {
  const { exitCode, lines } = summarize([{ name: 'fs', ok: true, seconds: 1 }], new Set(['fs']));
  assert.equal(exitCode, 0);
  assert.match(lines.join('\n'), /fs.*remove from known-failing\.json/);
});

test('loadKnownFailing reads the committed list as an array of existing packages', () => {
  const known = loadKnownFailing(root);
  const all = selectPackages({ ci: false, root });
  for (const name of known) assert.ok(all.includes(name), `${name} is not a package with a test script`);
});
