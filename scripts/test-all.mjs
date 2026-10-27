#!/usr/bin/env node
/**
 * Runs `npm test` of every package that has one and exits 1 when a suite fails.
 *
 *   node scripts/test-all.mjs [--concurrency N] [--only pkg,pkg] [--ci] [--timeout MINUTES]
 *
 * --ci ( or CI=true ) skips the packages in scripts/coverage/local-only.json ( they need external services ).
 * Packages listed in scripts/known-failing.json may fail without failing the run; they are reported as
 * warnings, and a listed package that passes is reported so it can be removed from the list.
 * Build first ( `npm run build` ): packages import each other through the built lib/.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function loadKnownFailing(root = ROOT) {
  return new Set(JSON.parse(readFileSync(join(root, 'scripts/known-failing.json'), 'utf8')));
}

export function selectPackages({ ci, root = ROOT, only }) {
  const localOnly = new Set(JSON.parse(readFileSync(join(root, 'scripts/coverage/local-only.json'), 'utf8')).packages);
  return readdirSync(join(root, 'packages'))
    .filter((name) => existsSync(join(root, 'packages', name, 'package.json')))
    .filter((name) => JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')).scripts?.test)
    .filter((name) => !(ci && localOnly.has(name)))
    .filter((name) => !only || only.includes(name));
}

export function summarize(results, knownFailing = new Set()) {
  const failed = results.filter((r) => !r.ok && !knownFailing.has(r.name));
  const tolerated = results.filter((r) => !r.ok && knownFailing.has(r.name));
  const fixed = results.filter((r) => r.ok && knownFailing.has(r.name));
  const lines = results.map((r) => {
    const status = r.ok ? 'passed' : knownFailing.has(r.name) ? 'known-failing' : 'failed';
    return `${r.name.padEnd(28)} ${status.padEnd(13)} ${r.seconds.toFixed(1).padStart(7)}s`;
  });
  for (const r of tolerated) lines.push(`WARNING: ${r.name} failed but is listed in scripts/known-failing.json; the gate ignores it. Fix it.`);
  for (const r of fixed) lines.push(`${r.name} passes now: remove from known-failing.json`);
  lines.push(`${results.length - failed.length - tolerated.length}/${results.length} test suites passed` + (tolerated.length ? `, ${tolerated.length} known-failing` : ''));
  return { exitCode: failed.length ? 1 : 0, lines };
}

function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else process.kill(-child.pid, 'SIGKILL');
}

function runOne(name, root, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('npm', ['test', '--ignore-scripts', '--silent'], { cwd: join(root, 'packages', name), shell: true, stdio: 'pipe', detached: process.platform !== 'win32' });
    let out = '';
    let timedOut = false;
    // A hung suite must fail the run instead of holding the job until the workflow timeout.
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) out += `
Killed after ${timeoutMs / 60000} minutes without finishing.
`;
      resolve({ name, ok: code === 0 && !timedOut, seconds: (Date.now() - started) / 1000, out });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const ci = args.includes('--ci') || process.env.CI === 'true';
  const concurrency = Number(args[args.indexOf('--concurrency') + 1]) || 4;
  const timeoutMs = (Number(args[args.indexOf('--timeout') + 1]) || 20) * 60000;
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : undefined;
  const knownFailing = loadKnownFailing();
  const queue = selectPackages({ ci, only });
  const results = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const r = await runOne(queue.shift(), ROOT, timeoutMs);
        console.log(`${r.ok ? 'passed' : 'FAILED'} ${r.name} ( ${r.seconds.toFixed(0)}s )`);
        if (!r.ok) process.stdout.write(`\n--- ${r.name} failed${knownFailing.has(r.name) ? ' ( known-failing )' : ''} ---\n${r.out}\n`);
        results.push(r);
      }
    }),
  );
  const { exitCode, lines } = summarize(results.sort((a, b) => a.name.localeCompare(b.name)), knownFailing);
  console.log(lines.join('\n'));
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
