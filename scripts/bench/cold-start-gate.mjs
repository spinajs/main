#!/usr/bin/env node
// Cold-start gate: measures every target of cold-start-targets.json and fails when a median exceeds its limit.
// Usage: node scripts/bench/cold-start-gate.mjs [--targets scripts/bench/cold-start-targets.json] [--runs N] [--out-dir .]
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coldStart, median } from './cold-start.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE_RUNS = 30;

export function readTargets(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.targets) || config.targets.length === 0) throw new Error(`${file} lists no targets`);
  for (const t of config.targets) {
    if (!t.name || !Number.isInteger(t.controllers) || !Number.isInteger(t.routes) || !['off', 'require'].includes(t.mode) || !(t.maxMedianMs > 0)) {
      throw new Error(`${file}: target ${JSON.stringify(t)} needs name, controllers, routes, mode (off | require) and maxMedianMs`);
    }
  }
  return { runs: config.runs ?? 30, reruns: config.reruns ?? 0, targets: config.targets };
}

/** One row per target: its measured median against the limit. `result` is what coldStart() resolved with. */
export function verdictOf(target, result) {
  const measured = result.modes[target.mode];
  if (!measured) throw new Error(`the ${target.name} run did not measure mode ${target.mode}`);
  return { name: target.name, mode: target.mode, medianMs: measured.medianMs, minMs: measured.minMs, maxMedianMs: target.maxMedianMs, pass: measured.medianMs <= target.maxMedianMs };
}

/** A target fails only when every attempt exceeds its limit: one rerun absorbs a noisy neighbour on a shared runner. */
export function finalVerdicts(attempts) {
  return attempts.map((tries) => ({ ...tries.at(-1), pass: tries.some((t) => t.pass), attempts: tries }));
}

export function summaryOf(verdicts, { baselineMs, runs, node }) {
  const attempt = (a) => `${a.medianMs} ms (min ${a.minMs})`;
  return [
    `### Cold-start gate (${runs} runs per mode, ${node}, compile cache on)`,
    '',
    '| target | mode | median time-to-listening | limit | result |',
    '| --- | --- | --- | --- | --- |',
    ...verdicts.map((v) => `| ${v.name} | ${v.mode} | ${v.attempts.map(attempt).join(', rerun ')} | ${v.maxMedianMs} ms | ${v.pass ? 'pass' : '**FAIL**'} |`),
    '',
    `Node start-up on this runner (\`node -e 0\`, median of ${BASELINE_RUNS}): ${baselineMs} ms. Limits live in \`scripts/bench/cold-start-targets.json\`.`,
    '',
  ].join('\n');
}

function runsOf(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error('--runs needs a positive integer');
  return n;
}

function parseArgs(argv) {
  const options = { targets: join(HERE, 'cold-start-targets.json'), runs: undefined, outDir: '.' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--targets') options.targets = resolve(argv[++i]);
    else if (arg === '--runs') options.runs = runsOf(argv[++i]);
    else if (arg === '--out-dir') options.outDir = resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function nodeStartupMs() {
  const samples = [];
  for (let i = 0; i < BASELINE_RUNS; i++) {
    const started = performance.now();
    spawnSync(process.execPath, ['-e', '0']);
    samples.push(performance.now() - started);
  }
  return Math.round(median(samples));
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function measureTarget(target, runs, outDir, attempt) {
  const out = join(outDir, `bench-${slug(target.name)}${attempt ? `-rerun${attempt}` : ''}.json`);
  const result = await coldStart({ controllers: target.controllers, routes: target.routes, runs, modes: ['off', 'require'], compileCache: true, out, keep: false });
  return verdictOf(target, result);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readTargets(options.targets);
  const runs = options.runs ?? config.runs;
  mkdirSync(options.outDir, { recursive: true });
  const baselineMs = nodeStartupMs();

  const attempts = [];
  for (const target of config.targets) {
    const tries = [await measureTarget(target, runs, options.outDir, 0)];
    while (!tries.at(-1).pass && tries.length <= config.reruns) {
      console.log(`${target.name}: median ${tries.at(-1).medianMs} ms over ${target.maxMedianMs} ms, measuring again`);
      tries.push(await measureTarget(target, runs, options.outDir, tries.length));
    }
    attempts.push(tries);
  }

  const verdicts = finalVerdicts(attempts);
  const summary = summaryOf(verdicts, { baselineMs, runs, node: process.version });
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  const failed = verdicts.filter((v) => !v.pass);
  for (const v of failed) console.error(`cold start over target: ${v.name} (${v.mode}) median ${v.medianMs} ms > ${v.maxMedianMs} ms`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
