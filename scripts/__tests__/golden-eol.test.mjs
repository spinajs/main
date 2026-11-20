import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Fixtures a test compares with generated text as a string: checked out with CRLF, that test fails.
const GOLDEN = [
  'packages/authz-ir/test/fixtures/docs.fga',
  'packages/authz-ir/test/fixtures/impact-3-3.fga',
  'packages/authz-ir/test/fixtures/impact-3-3.ir.json',
  'packages/authz-rbac/test/fixtures/invoice.ir.json',
];

test('the golden fixtures of the authz packages are checked out with LF on every platform', () => {
  const out = execFileSync('git', ['check-attr', 'eol', '--', ...GOLDEN], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(
    out.trim().split(/\r?\n/),
    GOLDEN.map((file) => `${file}: eol: lf`),
  );
});
