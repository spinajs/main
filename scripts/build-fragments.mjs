#!/usr/bin/env node
/**
 * Writes `lib/manifest.fragment.json` for every workspace package that has sources, using the
 * @spinajs/compiler analyzer. Runs after `tsc -b`, so the compiler itself is already built.
 * Only analyzer errors fail the run; warnings are counted and printed.
 *
 *   node scripts/build-fragments.mjs [--only a,b] [--packages-dir <dir>] [--concurrency N]
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { MANIFEST_PATH, isAnalyzable } from './manifest-field.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function listAnalyzable(packagesDir, only = []) {
  return readdirSync(packagesDir)
    .filter((name) => only.length === 0 || only.includes(name))
    .map((name) => join(packagesDir, name))
    .filter(isAnalyzable);
}

export function countSeverities(diagnostics) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) out[d.severity]++;
  return out;
}

/** Runs `worker` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return results;
}

async function analyzeInThread(dir) {
  const { analyzePackage } = await import('@spinajs/compiler');
  const started = performance.now();
  const fragment = await analyzePackage({ tsconfig: join(dir, 'tsconfig.build.json'), packageRoot: dir, schemaDerivation: true });
  const out = join(dir, MANIFEST_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(fragment, null, 2)}\n`);
  return { name: fragment.package.name, ms: Math.round(performance.now() - started), counts: countSeverities(fragment.diagnostics), diagnostics: fragment.diagnostics };
}

if (!isMainThread) {
  parentPort.on('message', async (dir) => {
    try {
      parentPort.postMessage({ ok: true, result: await analyzeInThread(dir) });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

const crashResult = (dir, reason) => ({ name: dir, ms: 0, counts: { error: 1, warning: 0, info: 0 }, diagnostics: [], crash: reason });

/** Resolves with the package result; a worker that errors or exits first yields a crash result with `dead: true`. */
function runInWorker(worker, dir) {
  return new Promise((resolveRun) => {
    const settle = (result) => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      resolveRun(result);
    };
    const onMessage = (msg) => settle(msg.ok ? msg.result : crashResult(dir, msg.error));
    const onError = (err) => settle({ ...crashResult(dir, err instanceof Error ? err.message : String(err)), dead: true });
    const onExit = (code) => settle({ ...crashResult(dir, `worker exited with code ${code}`), dead: true });
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage(dir);
  });
}

/** Analyzes `dirs` in a pool of worker threads; a dead worker fails its package and is replaced. */
export async function analyzeAll(dirs, { concurrency, workerFile = fileURLToPath(import.meta.url), onResult = () => {} }) {
  const spawn = () => new Worker(workerFile);
  const free = Array.from({ length: Math.max(1, Math.min(concurrency, dirs.length)) }, spawn);
  const size = free.length;
  const results = await mapPool(dirs, size, async (dir) => {
    let worker = free.pop();
    const result = await runInWorker(worker, dir);
    if (result.dead) {
      await worker.terminate();
      worker = spawn();
    }
    free.push(worker);
    onResult(result);
    return result;
  });
  await Promise.all(free.map((w) => w.terminate()));
  return results;
}

export function parseConcurrency(raw, fallback) {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--concurrency must be a positive integer, got "${raw}"`);
  return Number(raw);
}

function arg(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

const formatResult = (r) => `${r.name} ${r.ms}ms ${r.counts.error} error(s), ${r.counts.warning} warning(s)${r.crash ? ` crashed: ${r.crash}` : ''}`;

async function main() {
  const args = process.argv.slice(2);
  const packagesDir = resolve(arg(args, '--packages-dir') ?? join(ROOT, 'packages'));
  const only = (arg(args, '--only') ?? '').split(',').filter(Boolean);
  let concurrency;
  try {
    concurrency = parseConcurrency(arg(args, '--concurrency'), Math.min(4, availableParallelism()));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const dirs = listAnalyzable(packagesDir, only);

  const started = performance.now();
  const results = await analyzeAll(dirs, { concurrency, onResult: (r) => console.log(formatResult(r)) });

  let failed = 0;
  for (const r of results) {
    for (const d of r.diagnostics.filter((x) => x.severity === 'error')) console.log(`  error ${r.name}: ${d.code} ${d.source ? `${d.source.file}:${d.source.line}` : '-'} ${d.message}`);
    if (r.counts.error > 0) failed++;
  }
  const totals = results.reduce((t, r) => ({ error: t.error + r.counts.error, warning: t.warning + r.counts.warning }), { error: 0, warning: 0 });
  console.log(`\nmanifest fragments: ${results.length - failed}/${results.length} packages ok, ${totals.warning} warning(s), ${totals.error} error(s), ${((performance.now() - started) / 1000).toFixed(1)}s`);
  process.exitCode = failed > 0 ? 1 : 0;
}

if (isMainThread && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
