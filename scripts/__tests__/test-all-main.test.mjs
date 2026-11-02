import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../test-all.mjs', import.meta.url));

/** A repository of its own: test-all finds packages next to the script, so a copy runs over these fake suites. */
function repo(suites, knownFailing = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-test-all-')));
  mkdirSync(join(root, 'scripts', 'coverage'), { recursive: true });
  cpSync(script, join(root, 'scripts', 'test-all.mjs'));
  writeFileSync(join(root, 'scripts', 'coverage', 'local-only.json'), JSON.stringify({ packages: [] }));
  writeFileSync(join(root, 'scripts', 'known-failing.json'), JSON.stringify(knownFailing));
  writeFileSync(join(root, 'scripts', 'test-timeouts.json'), '{}');
  for (const [name, test] of Object.entries(suites)) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name, scripts: { test } }));
  }
  return root;
}

const spawnOptions = { encoding: 'utf8', maxBuffer: 2 ** 26, env: { ...process.env, CI: '' } };
const run = (root, ...args) => spawnSync(process.execPath, [join(root, 'scripts', 'test-all.mjs'), '--concurrency', '1', ...args], spawnOptions);

const pass = 'node -e "0"';
const failLoudly = 'node -e "process.stdout.write(String.fromCharCode(120).repeat(2000000)); process.exit(3)"';

test('a failed suite fails the run, and the summary survives a large output on a pipe', () => {
  const root = repo({ a: pass, b: failLoudly });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /1\/2 test suites passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a known-failing suite does not fail the run', () => {
  const root = repo({ a: pass, b: failLoudly }, ['b']);
  try {
    assert.equal(run(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--only that matches nothing fails', () => {
  const root = repo({ a: pass });
  try {
    const result = run(root, '--only', 'nosuchpkg');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /nosuchpkg/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--only with one name of two wrong fails before running anything', () => {
  const root = repo({ a: pass });
  try {
    const result = run(root, '--only', 'a,nosuchpkg');
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout, /passed a/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repository with no suite fails: running nothing proves nothing', () => {
  const root = repo({});
  mkdirSync(join(root, 'packages'), { recursive: true });
  try {
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /no test suite ran/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('started through a link it still runs', () => {
  const root = repo({ b: failLoudly });
  const link = join(root, 'linked');
  symlinkSync(root, link, 'junction');
  try {
    const result = spawnSync(process.execPath, [join(link, 'scripts', 'test-all.mjs'), '--concurrency', '1'], spawnOptions);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /0\/1 test suites passed/);
  } finally {
    rmSync(link, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
