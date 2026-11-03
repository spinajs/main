import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { typesVersionsGaps } from '../types-versions.mjs';

const pkg = (typesVersions) => ({
  exports: { '.': { types: './lib/index.d.ts' }, './a': { types: './lib/a.d.ts', import: './lib/a.js' }, './b/*': { types: './lib/b/*.d.ts' } },
  ...(typesVersions ? { typesVersions } : {}),
});

test('a typesVersions map must list every typed subpath export', () => {
  assert.deepEqual(typesVersionsGaps(pkg({ '*': { a: ['lib/a.d.ts'] } })), []);
  assert.equal(typesVersionsGaps(pkg({ '*': {} })).length, 1);
  assert.equal(typesVersionsGaps(pkg({ '*': { a: ['lib/other.d.ts'] } })).length, 1);
});

test('a package without a typesVersions map is left to exports', () => {
  assert.deepEqual(typesVersionsGaps(pkg(undefined)), []);
});

test('no workspace package leaves a subpath out of its typesVersions map', () => {
  const dir = join(process.cwd(), 'packages');
  const gaps = readdirSync(dir)
    .map((name) => join(dir, name, 'package.json'))
    .filter((file) => existsSync(file))
    .map((file) => JSON.parse(readFileSync(file, 'utf8')))
    .flatMap((p) => typesVersionsGaps(p).map((gap) => `${p.name}: ${gap}`));
  assert.deepEqual(gaps, []);
});
