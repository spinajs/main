#!/usr/bin/env node
// Cold-start gate: measures every target of cold-start-targets.json with a warm and a cold compile cache, reports the
// medians against the 4.x limits and fails when a target regresses more than maxRegression against the CI baseline.
// Usage: node scripts/bench/cold-start-gate.mjs [--targets cold-start-targets.json] [--baseline cold-start-baseline.json] [--runs N] [--out-dir .]
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coldStart, median } from './cold-start.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTUP_RUNS = 30;
const CACHES = ['warm', 'cold'];
export const CANDIDATE_FILE = 'cold-start-baseline.candidate.json';

const round = (n) => Math.round(n * 10) / 10;
const percent = (change) => `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;

export function readTargets(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.targets) || config.targets.length === 0) throw new Error(`${file} lists no targets`);
  for (const t of config.targets) {
    if (!t.name || !Number.isInteger(t.controllers) || !Number.isInteger(t.routes) || !['off', 'require'].includes(t.mode) || !(t.maxMedianMs > 0)) {
      throw new Error(`${file}: target ${JSON.stringify(t)} needs name, controllers, routes, mode (off | require) and maxMedianMs`);
    }
  }
  const maxRegression = config.maxRegression ?? 0.15;
  if (!(maxRegression > 0)) throw new Error(`${file}: maxRegression must be a fraction above 0, such as 0.15`);
  return { runs: config.runs ?? 30, reruns: config.reruns ?? 0, enforceLimits: config.enforceLimits === true, maxRegression, targets: config.targets };
}

/** A missing file reads as an empty baseline. */
export function readBaseline(file) {
  if (!existsSync(file)) return { measuredOn: null, targets: {} };
  const baseline = JSON.parse(readFileSync(file, 'utf8'));
  for (const [name, entry] of Object.entries(baseline.targets ?? {})) {
    if (!(entry?.warmMs > 0) || !(entry?.coldMs > 0)) throw new Error(`${file}: target ${name} needs warmMs and coldMs`);
  }
  return { measuredOn: baseline.measuredOn ?? null, targets: baseline.targets ?? {} };
}

export const hasCiNumbers = (baseline) => baseline.measuredOn?.ci === 'github-actions' && Object.keys(baseline.targets).length > 0;

/**
 * `{ baseline }` when the regression check runs, `{ skipped: reason }` otherwise. A baseline measured on a GitHub runner
 * says nothing about another machine, so outside CI it is compared only when passed with --baseline on purpose.
 */
export function regressionCheckOf(baseline, { onCi, explicit }) {
  if (!hasCiNumbers(baseline)) return { skipped: 'the baseline holds no numbers from a CI run yet (see scripts/bench/README.md, "The baseline")' };
  if (!onCi && !explicit) return { skipped: 'the baseline holds numbers of a GitHub runner, so it is compared on CI only; pass --baseline to compare this machine with it' };
  return { baseline };
}

function regressionOf(measured, baselineMs, maxRegression) {
  const change = Math.round((measured.medianMs / baselineMs - 1) * 1e4) / 1e4;
  return { baselineMs, change, over: change > maxRegression };
}

/**
 * One attempt of one target. `result` is what coldStart() resolved with; `baseline` is the target's baseline entry, or
 * undefined when the regression check does not run. A median over the 4.x limit fails only with `enforceLimits`.
 */
export function verdictOf(target, result, { enforceLimits, maxRegression, baseline }) {
  const measured = result.modes[target.mode];
  if (!measured?.warm || !measured?.cold) throw new Error(`the ${target.name} run did not measure ${target.mode} with a warm and a cold compile cache`);
  const pick = ({ medianMs, minMs }) => ({ medianMs, minMs });
  const warm = pick(measured.warm);
  const cold = pick(measured.cold);
  const limit = { maxMedianMs: target.maxMedianMs, over: warm.medianMs > target.maxMedianMs, enforced: enforceLimits };
  let regression;
  if (baseline) {
    const byCache = { warm: regressionOf(warm, baseline.warmMs, maxRegression), cold: regressionOf(cold, baseline.coldMs, maxRegression) };
    regression = { ...byCache, over: byCache.warm.over || byCache.cold.over };
  }
  return { name: target.name, mode: target.mode, warm, cold, environment: result.environment, limit, regression, pass: !(limit.enforced && limit.over) && !regression?.over };
}

/** A target fails only when every attempt fails: one rerun absorbs a noisy neighbour on a shared runner. */
export function finalVerdicts(attempts) {
  return attempts.map((tries) => ({ ...tries.at(-1), pass: tries.some((t) => t.pass), attempts: tries }));
}

const describeEnvironment = (e) => `${e.cpu}, ${e.cores} cores`;

export function summaryOf(verdicts, { runs, enforceLimits, maxRegression, regression }) {
  const timing = (cache) => (v) => v.attempts.map((a) => `${a[cache].medianMs} ms (min ${a[cache].minMs})`).join(', rerun ');
  const row = (v, cache) => {
    const last = v.attempts.at(-1);
    const limit = cache === 'warm' ? `${v.limit.maxMedianMs} ms${v.limit.over ? `, over${v.limit.enforced ? '' : ' (not enforced)'}` : ''}` : '-';
    const check = last.regression?.[cache];
    const regressed = v.attempts.every((a) => a.regression?.[cache].over);
    const failed = regressed || (cache === 'warm' && v.limit.enforced && v.attempts.every((a) => a.limit.over));
    const result = regressed ? '**regressed**' : failed ? '**over limit**' : 'pass';
    return `| ${v.name} | ${cache} | ${timing(cache)(v)} | ${limit} | ${check ? `${check.baselineMs} ms` : '-'} | ${check ? percent(check.change) : '-'} | ${result} |`;
  };
  const environments = verdicts.flatMap((v) => v.attempts.map((a, i) => `- ${v.name}, ${i ? `rerun ${i}` : 'first run'}: ${describeEnvironment(a.environment)}, \`node -e 0\` ${a.environment.nodeStartupMs} ms, calibration ${a.environment.calibrationMs} ms`));
  const first = verdicts[0]?.environment;
  const measuredOn = regression.baseline?.measuredOn;
  return [
    `### Cold-start gate: ${enforceLimits ? 'limits enforced' : 'report only'} (${runs} runs per compile cache state, ${first?.node}, ${first?.platform})`,
    '',
    `Time from spawning \`node\` to the listening line, manifest mode \`require\`. A warm compile cache is the one a previous start wrote; a cold one is empty, as on a first start. ${
      enforceLimits ? 'A warm median over its 4.x limit fails the job.' : 'The 4.x limits are reported, not enforced (`enforceLimits: false`).'
    } A target fails when its warm or cold median is more than ${maxRegression * 100}% over the baseline in every attempt.`,
    '',
    '| target | compile cache | median time-to-listening | 4.x limit | baseline | change | result |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...verdicts.flatMap((v) => CACHES.map((cache) => row(v, cache))),
    '',
    regression.skipped ? `Regression check skipped: ${regression.skipped}.` : `Baseline: ${describeEnvironment(measuredOn)}, calibration ${measuredOn.calibrationMs} ms, measured ${measuredOn.date ?? '(no date)'} in ${measuredOn.runUrl ?? '(no run link)'}.`,
    '',
    'Runner per attempt (calibration: median of a fixed CPU-bound JS workload, to tell a slower machine from a slower framework):',
    ...environments,
    '',
    'Limits and the regression threshold: `scripts/bench/cold-start-targets.json`; baseline: `scripts/bench/cold-start-baseline.json`.',
    '',
  ].join('\n');
}

/** The baseline file this run would write; update-cold-start-baseline.mjs takes it from a CI run. */
export function baselineCandidate(verdicts, env, now) {
  const e = verdicts[0].environment;
  const onCi = env.GITHUB_ACTIONS === 'true';
  const measuredOn = {
    ci: onCi ? 'github-actions' : 'local',
    ...(onCi ? { runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, commit: env.GITHUB_SHA, ref: env.GITHUB_REF_NAME } : {}),
    date: now.toISOString(),
    cpu: e.cpu,
    cores: e.cores,
    node: e.node,
    platform: e.platform,
    calibrationMs: e.calibrationMs,
    nodeStartupMs: e.nodeStartupMs,
  };
  return { measuredOn, targets: Object.fromEntries(verdicts.map((v) => [v.name, { warmMs: v.warm.medianMs, coldMs: v.cold.medianMs }])) };
}

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a positive integer`);
  return n;
}

function parseArgs(argv) {
  const options = { targets: join(HERE, 'cold-start-targets.json'), baseline: join(HERE, 'cold-start-baseline.json'), explicitBaseline: false, runs: undefined, outDir: '.' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--targets') options.targets = resolve(argv[++i]);
    else if (arg === '--baseline') {
      options.baseline = resolve(argv[++i]);
      options.explicitBaseline = true;
    } else if (arg === '--runs') options.runs = positiveInt(arg, argv[++i]);
    else if (arg === '--out-dir') options.outDir = resolve(argv[++i]);
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

function nodeStartupMs() {
  const samples = [];
  for (let i = 0; i < STARTUP_RUNS; i++) {
    const started = performance.now();
    spawnSync(process.execPath, ['-e', '0']);
    samples.push(performance.now() - started);
  }
  return Math.round(median(samples));
}

let calibrationSink = 0;

// Integer arithmetic, object allocation and JSON round trips: the kind of work a boot does besides I/O.
function calibrationMs() {
  const samples = [];
  for (let run = 0; run < 7; run++) {
    const started = performance.now();
    let acc = 0;
    for (let i = 0; i < 5e6; i++) acc = (acc + i * 31) % 1000003;
    const records = Array.from({ length: 2e4 }, (_, i) => ({ id: i, name: `n${i}`, tags: [i % 7, i % 11] }));
    acc += JSON.parse(JSON.stringify(records)).length;
    calibrationSink ^= acc;
    samples.push(performance.now() - started);
  }
  return round(median(samples));
}

function environmentOf() {
  return {
    cpu: cpus()[0]?.model?.trim() ?? 'unknown CPU',
    cores: availableParallelism(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    nodeStartupMs: nodeStartupMs(),
    calibrationMs: calibrationMs(),
  };
}

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

async function measureTarget(target, runs, outDir, attempt, check) {
  const out = join(outDir, `bench-${slug(target.name)}${attempt ? `-rerun${attempt}` : ''}.json`);
  const environment = environmentOf();
  const result = await coldStart({ controllers: target.controllers, routes: target.routes, runs, modes: [target.mode], caches: CACHES, out, keep: false, context: { environment } });
  return verdictOf(target, result, check);
}

function report(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = readTargets(options.targets);
  const runs = options.runs ?? config.runs;
  const regression = regressionCheckOf(readBaseline(options.baseline), { onCi: process.env.GITHUB_ACTIONS === 'true', explicit: options.explicitBaseline });
  if (regression.skipped) console.log(`regression check skipped: ${regression.skipped}`);
  mkdirSync(options.outDir, { recursive: true });

  const attempts = [];
  for (const target of config.targets) {
    const check = { enforceLimits: config.enforceLimits, maxRegression: config.maxRegression, baseline: regression.baseline?.targets[target.name] };
    const tries = [await measureTarget(target, runs, options.outDir, 0, check)];
    while (!tries.at(-1).pass && tries.length <= config.reruns) {
      console.log(`${target.name}: failed its check, measuring again`);
      tries.push(await measureTarget(target, runs, options.outDir, tries.length, check));
    }
    attempts.push(tries);
  }

  const verdicts = finalVerdicts(attempts);
  report(summaryOf(verdicts, { runs, enforceLimits: config.enforceLimits, maxRegression: config.maxRegression, regression }));
  writeFileSync(join(options.outDir, CANDIDATE_FILE), JSON.stringify(baselineCandidate(verdicts, process.env, new Date()), null, 2) + '\n');
  const failed = verdicts.filter((v) => !v.pass);
  for (const v of failed) {
    const why = v.regression?.over ? `more than ${config.maxRegression * 100}% over the baseline` : `warm median ${v.warm.medianMs} ms over the ${v.limit.maxMedianMs} ms limit`;
    console.error(`cold start: ${v.name} (${v.mode}) failed in every attempt: ${why}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Cold-start gate could not run\n\n\`\`\`\n${message.slice(0, 4000)}\n\`\`\`\n`);
    process.exitCode = 1;
  });
}
