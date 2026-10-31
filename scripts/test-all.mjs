#!/usr/bin/env node
/**
 * Runs `npm test` of every package that has one and exits 1 when a suite fails.
 *
 *   node scripts/test-all.mjs [--concurrency N] [--only pkg,pkg] [--ci] [--timeout MINUTES]
 *
 * --ci ( or CI=true ) skips the packages in scripts/coverage/local-only.json ( they need external services ).
 * A suite running longer than its limit is killed and counts as failed: scripts/test-timeouts.json gives
 * per-package minutes, --timeout the default ( 20 ).
 * Packages listed in scripts/known-failing.json may fail without failing the run; they are reported as
 * warnings, and a listed package that passes is reported so it can be removed from the list.
 * Build first ( `npm run build` ): packages import each other through the built lib/.
 */
import { readdirSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function loadKnownFailing(root = ROOT) {
  return new Set(JSON.parse(readFileSync(join(root, 'scripts/known-failing.json'), 'utf8')));
}

export const DEFAULT_TIMEOUT_MINUTES = 20;

export function loadTimeouts(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'scripts/test-timeouts.json'), 'utf8'));
}

export function timeoutMinutes(name, timeouts, fallback = DEFAULT_TIMEOUT_MINUTES) {
  return timeouts[name] ?? fallback;
}

export function flagValue(args, name) {
  const value = args[args.indexOf(name) + 1];
  return args.includes(name) && value !== undefined && !value.startsWith('--') ? value : undefined;
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
  if (results.length === 0) return { exitCode: 1, lines: ['no test suite ran'] };
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
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // the group already exited
    }
  }
}

/** Runs a shell command; a run exceeding timeoutMs is killed with its whole process tree and reported as failed. */
export function runProcess(command, { cwd, env, timeoutMs, inherit = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, { cwd, env, shell: true, stdio: inherit ? 'inherit' : 'pipe', detached: process.platform !== 'win32' });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) out += `
Killed after ${timeoutMs / 60000} minutes without finishing.
`;
      resolve({ ok: code === 0 && !timedOut, timedOut, seconds: (Date.now() - started) / 1000, out });
    });
  });
}

export async function runPackage(name, { root = ROOT, timeoutMs, env, inherit }) {
  const r = await runProcess('npm test --ignore-scripts --silent', { cwd: join(root, 'packages', name), env, timeoutMs, inherit });
  return { name, ...r };
}

async function main() {
  const args = process.argv.slice(2);
  const ci = args.includes('--ci') || process.env.CI === 'true';
  const concurrency = Number(flagValue(args, '--concurrency')) || 4;
  const defaultTimeout = Number(flagValue(args, '--timeout')) || DEFAULT_TIMEOUT_MINUTES;
  const timeouts = loadTimeouts();
  if (args.includes('--only') && flagValue(args, '--only') === undefined) {
    console.error('--only needs a comma-separated list of package names');
    process.exit(2);
  }
  const only = flagValue(args, '--only')?.split(',');
  const knownFailing = loadKnownFailing();
  const queue = selectPackages({ ci, only });
  const unmatched = only?.filter((name) => !queue.includes(name)) ?? [];
  if (unmatched.length) {
    console.error(`--only names what would not run: ${unmatched.join(', ')}`);
    process.exit(2);
  }
  const results = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const name = queue.shift();
        const r = await runPackage(name, { timeoutMs: timeoutMinutes(name, timeouts, defaultTimeout) * 60000 });
        console.log(`${r.ok ? 'passed' : 'FAILED'} ${r.name} ( ${r.seconds.toFixed(0)}s )`);
        if (!r.ok) process.stdout.write(`\n--- ${r.name} failed${knownFailing.has(r.name) ? ' ( known-failing )' : ''} ---\n${r.out}\n`);
        results.push(r);
      }
    }),
  );
  const { exitCode, lines } = summarize(results.sort((a, b) => a.name.localeCompare(b.name)), knownFailing);
  console.log(lines.join('\n'));
  // Not process.exit(): it drops what is still queued on a piped stdout, which on CI is the end of the last failed suite and this summary.
  process.exitCode = exitCode;
}

// Through a symlink or a junction argv[1] is the link, and a plain comparison would exit 0 having run nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
