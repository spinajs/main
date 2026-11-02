import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleSpecs, testGlobProblems, unquotedGlobs } from '../test-globs.mjs';

test('unquotedGlobs finds a ** the shell would expand, in any script', () => {
  assert.deepEqual(unquotedGlobs({ test: 'ts-mocha -p tsconfig.json test/**/*.test.ts --exit', 'test:x': 'mocha test/a/**/*.ts' }), ['test: test/**/*.test.ts', 'test:x: test/a/**/*.ts']);
});

test('unquotedGlobs accepts a quoted glob, a single star and no scripts', () => {
  assert.deepEqual(unquotedGlobs({ test: 'ts-mocha -p tsconfig.json "test/**/*.test.ts"', b: "mocha 'test/**/*.ts'", c: 'ts-mocha test/*.test.ts' }), []);
  assert.deepEqual(unquotedGlobs(undefined), []);
});

test('staleSpecs names a spec that matches nothing, and a package without a mocharc has none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spinajs-test-globs-'));
  try {
    assert.deepEqual(staleSpecs(dir), []);
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'test', 'a.test.ts'), '');
    writeFileSync(join(dir, '.mocharc.json'), JSON.stringify({ spec: ['test/**/*.test.ts', 'packages/other/test/*.test.ts'] }));
    assert.deepEqual(staleSpecs(dir), ['packages/other/test/*.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no package in this repository has a test glob problem', () => {
  const packages = new URL('../../packages/', import.meta.url);
  const problems = readdirSync(packages).flatMap((name) => {
    const dir = new URL(`${name}/`, packages);
    try {
      return testGlobProblems(dir.pathname.replace(/^\/([A-Za-z]:)/, '$1'), JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'))).map((p) => `${name}: ${p}`);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  });
  assert.deepEqual(problems, []);
});
