#!/usr/bin/env node
/**
 * Writes `lib/manifest.fragment.json` for every workspace package that has sources, using the
 * @spinajs/compiler analyzer. Runs after `tsc -b`, so the compiler itself is already built.
 * Only analyzer errors fail the run; warnings are counted and printed.
 *
 *   node scripts/build-fragments.mjs [--only a,b] [--packages-dir <dir>] [--concurrency N]
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { MANIFEST_PATH } from './manifest-field.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function listAnalyzable(packagesDir, only = []) {
  return readdirSync(packagesDir)
    .filter((name) => only.length === 0 || only.includes(name))
    .map((name) => join(packagesDir, name))
    .filter((dir) => existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'tsconfig.build.json')) && existsSync(join(dir, 'src')));
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

function runInWorker(worker, dir) {
  return new Promise((resolveRun) => {
    worker.once('message', (msg) => resolveRun(msg.ok ? msg.result : { name: dir, ms: 0, counts: { error: 1, warning: 0, info: 0 }, diagnostics: [], crash: msg.error }));
    worker.postMessage(dir);
  });
}

function arg(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const packagesDir = resolve(arg(args, '--packages-dir') ?? join(ROOT, 'packages'));
  const only = (arg(args, '--only') ?? '').split(',').filter(Boolean);
  const concurrency = Number(arg(args, '--concurrency') ?? Math.min(4, availableParallelism()));
  const dirs = listAnalyzable(packagesDir, only);

  const started = performance.now();
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, dirs.length)) }, () => new Worker(fileURLToPath(import.meta.url)));
  const free = [...workers];
  const results = await mapPool(dirs, workers.length, async (dir) => {
    const worker = free.pop();
    try {
      return await runInWorker(worker, dir);
    } finally {
      free.push(worker);
    }
  });
  await Promise.all(workers.map((w) => w.terminate()));

  let failed = 0;
  for (const r of results) {
    const { error, warning } = r.counts;
    console.log(`${r.name} ${r.ms}ms ${error} error(s), ${warning} warning(s)${r.crash ? ` crashed: ${r.crash}` : ''}`);
    for (const d of r.diagnostics.filter((x) => x.severity === 'error')) console.log(`  error ${d.code} ${d.source ? `${d.source.file}:${d.source.line}` : '-'} ${d.message}`);
    if (error > 0) failed++;
  }
  const totals = results.reduce((t, r) => ({ error: t.error + r.counts.error, warning: t.warning + r.counts.warning }), { error: 0, warning: 0 });
  console.log(`\nmanifest fragments: ${results.length - failed}/${results.length} packages ok, ${totals.warning} warning(s), ${totals.error} error(s), ${((performance.now() - started) / 1000).toFixed(1)}s`);
  process.exitCode = failed > 0 ? 1 : 0;
}

if (isMainThread && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
