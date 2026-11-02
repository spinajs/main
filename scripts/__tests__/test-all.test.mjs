import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { selectPackages, summarize, loadKnownFailing, loadTimeouts, timeoutMinutes, flagValue, runProcess } from '../test-all.mjs';

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
  assert.doesNotMatch(text, /^fs\s+failed/m);
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

test('timeoutMinutes prefers the per-package value over the default', () => {
  const timeouts = { authn: 5 };
  assert.equal(timeoutMinutes('authn', timeouts, 20), 5);
  assert.equal(timeoutMinutes('di', timeouts, 20), 20);
});

test('loadTimeouts reads the committed map for existing packages', () => {
  const all = selectPackages({ ci: false, root });
  for (const [name, minutes] of Object.entries(loadTimeouts(root))) {
    assert.ok(all.includes(name), `${name} is not a package with a test script`);
    assert.ok(minutes > 0);
  }
});

test('flagValue returns the value, or undefined when absent or valueless', () => {
  assert.equal(flagValue(['--only', 'di,fs'], '--only'), 'di,fs');
  assert.equal(flagValue(['--ci'], '--only'), undefined);
  assert.equal(flagValue(['--only'], '--only'), undefined);
  assert.equal(flagValue(['--only', '--ci'], '--only'), undefined);
});

/** A killed orphan stays a zombie until init reaps it, and in a container PID 1 may never do so. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!existsSync(`/proc/${pid}/stat`)) return process.platform !== 'linux';
  return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'));
}

test('runProcess kills a long-running child tree on timeout and reports failure', async () => {
  const r = await runProcess('node -e "console.log(process.pid);setInterval(function(){},1000)"', { cwd: root, timeoutMs: 3000 });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  const pid = Number.parseInt(r.out, 10);
  assert.ok(pid > 0);
  for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isAlive(pid), false);
});

test('runProcess reports success for a finishing command', async () => {
  const r = await runProcess('node -e "0"', { cwd: root, timeoutMs: 60000 });
  assert.equal(r.ok, true);
});
