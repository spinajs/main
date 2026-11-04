import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiresChangeset } from '../changeset-guard.mjs';
import { ckitPackagesOf, isCkitWorkspace } from '../ckit-workspaces.mjs';

const SCRIPTS = fileURLToPath(new URL('..', import.meta.url));
const COPIED = ['ckit-workspaces.mjs', 'link-safety.mjs', 'link-ckit.mjs', 'require-ckit.mjs'];

/** A repository with one ckit workspace next to a ckit checkout, both in a throwaway directory. */
function sandbox({ built = true } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spinajs-ckit-')));
  const root = join(base, 'repo');
  const ckit = join(base, 'ckit');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const file of COPIED) cpSync(join(SCRIPTS, file), join(root, 'scripts', file));
  mkdirSync(join(root, 'packages', 'ui'), { recursive: true });
  writeFileSync(join(root, 'packages', 'ui', 'package.json'), JSON.stringify({ name: '@spinajs/ui', ckit: { packages: ['components'] } }));
  mkdirSync(join(ckit, 'packages', 'components', built ? 'dist' : 'src'), { recursive: true });
  writeFileSync(join(ckit, 'packages', 'components', 'package.json'), JSON.stringify({ name: '@coderush/ckit-components' }));
  const git = (...args) => spawnSync('git', ['-C', ckit, '-c', 'user.email=ci@example.com', '-c', 'user.name=ci', ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const run = (cwd, script, args, env = {}) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  const box = {
    root,
    ckit,
    git,
    head: () => git('rev-parse', 'HEAD').stdout.trim(),
    link: (...args) => run(root, 'link-ckit.mjs', args, { CKIT_PATH: ckit }),
    requireCkit: (...args) => run(join(root, 'packages', 'ui'), 'require-ckit.mjs', args),
    linkPath: join(root, 'node_modules', '@coderush', 'ckit-components'),
    cleanup: () => {
      box.link('--unlink');
      rmSync(base, { recursive: true, force: true });
    },
  };
  return box;
}

test('ckitPackagesOf reads the "ckit" field and ignores anything else', () => {
  assert.deepEqual(ckitPackagesOf({ ckit: { packages: ['components', 'data'] } }), ['components', 'data']);
  assert.deepEqual(ckitPackagesOf({ ckit: { packages: 'components' } }), []);
  assert.deepEqual(ckitPackagesOf({ name: 'x' }), []);
  assert.equal(isCkitWorkspace({ ckit: { packages: [] } }), false);
  assert.equal(isCkitWorkspace({ ckit: { packages: ['core'] } }), true);
});

test('link junctions the listed packages and pins the checkout in ckit.lock', () => {
  const box = sandbox();
  try {
    const result = box.link();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(box.linkPath, 'package.json')));
    const lock = JSON.parse(readFileSync(join(box.root, 'packages', 'ui', 'ckit.lock'), 'utf8'));
    assert.deepEqual(lock, { commit: box.head(), dirty: false, packages: ['components'] });
    assert.equal(box.link('--check').status, 0);
  } finally {
    box.cleanup();
  }
});

test('--check fails once the checkout moves past the lock', () => {
  const box = sandbox();
  try {
    box.link();
    writeFileSync(join(box.ckit, 'CHANGELOG.md'), 'next');
    box.git('add', '-A');
    box.git('commit', '-q', '-m', 'next');
    const result = box.link('--check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ckit\.lock does not pin ckit/);
  } finally {
    box.cleanup();
  }
});

test('link refuses a package that was not built', () => {
  const box = sandbox({ built: false });
  try {
    const result = box.link();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@coderush\/ckit-components is missing/);
  } finally {
    box.cleanup();
  }
});

test('require-ckit skips without the link, runs with it, and --strict refuses to skip', () => {
  const box = sandbox();
  try {
    const skipped = box.requireCkit('node', '--version');
    assert.equal(skipped.status, 0);
    assert.match(skipped.stdout, /^SKIP @spinajs\/ui: ckit is not linked \(npm run link:ckit\)/);
    assert.equal(box.requireCkit('--strict', 'node', '--version').status, 1);
    box.link();
    const ran = box.requireCkit('node', '--version');
    assert.equal(ran.status, 0);
    assert.match(ran.stdout, /^v\d+\./m);
  } finally {
    box.cleanup();
  }
});

test('--unlink removes the junction and leaves the checkout alone', () => {
  const box = sandbox();
  try {
    box.link();
    assert.equal(box.link('--unlink').status, 0);
    assert.equal(existsSync(box.linkPath), false);
    assert.ok(existsSync(join(box.ckit, 'packages', 'components', 'package.json')));
  } finally {
    box.cleanup();
  }
});

test('changeset-guard leaves the Studio UI to its CHANGELOG', () => {
  assert.equal(requiresChangeset(['packages/studio-ui/src/main.tsx']), false);
  assert.equal(requiresChangeset(['packages/di/src/index.ts']), true);
});
