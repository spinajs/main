#!/usr/bin/env node
// Mutation gate: reads the Stryker JSON report of each target of targets.json, prints the scores against baseline.json
// and fails when a score is more than `tolerance` points below its baseline. It never writes the baseline: it writes
// mutation-baseline.candidate.json, which update-baseline.mjs copies into place in a reviewed commit.
// Usage: node scripts/mutation/gate.mjs (--reports <dir> | --report <target>=<mutation.json> ...) [--targets f] [--baseline f] [--out-dir d]
//        node scripts/mutation/gate.mjs --matrix
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CANDIDATE_FILE = 'mutation-baseline.candidate.json';
const STATUSES = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'CompileError', 'RuntimeError', 'Ignored', 'Pending'];
const SURVIVOR_LINES = 200;

const posix = (p) => p.replace(/\\/g, '/');
const fixed = (n) => (n === undefined ? '-' : n.toFixed(2));
const validOf = (c) => c.Killed + c.Timeout + c.Survived + c.NoCoverage;

export function readTargets(file) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!(config.tolerance > 0)) throw new Error(`${file}: tolerance must be a number of points above 0`);
  if (!Array.isArray(config.targets) || config.targets.length === 0) throw new Error(`${file} lists no targets`);
  const names = new Set();
  for (const t of config.targets) {
    if (!/^[a-z0-9-]+$/.test(t.name ?? '') || !t.package || !t.config || !Number.isInteger(t.concurrency) || t.concurrency < 1 || !Array.isArray(t.focus)) {
      throw new Error(`${file}: target ${JSON.stringify(t)} needs name (a-z, 0-9, -), package, config, concurrency (a positive integer) and focus`);
    }
    if (names.has(t.name)) throw new Error(`${file}: target ${t.name} is listed twice`);
    names.add(t.name);
  }
  return { tolerance: config.tolerance, targets: config.targets };
}

/** The file must exist: before the first CI score it holds { "measuredOn": null, "targets": {} }. */
export function readBaseline(file) {
  if (!existsSync(file)) throw new Error(`${file} is missing: the gate needs it; before the first CI score it holds {"measuredOn": null, "targets": {}}`);
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (baseline === null || typeof baseline.targets !== 'object' || baseline.targets === null || Array.isArray(baseline.targets)) throw new Error(`${file}: targets must be an object of { score, valid } entries`);
  for (const [name, entry] of Object.entries(baseline.targets)) {
    if (!(typeof entry?.score === 'number' && entry.score >= 0 && entry.score <= 100)) throw new Error(`${file}: target ${name} needs a score from 0 to 100`);
  }
  return { measuredOn: baseline.measuredOn ?? null, targets: baseline.targets };
}

export function countsOf(report) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const file of Object.values(report.files ?? {})) {
    for (const m of file.mutants) {
      if (!Object.hasOwn(counts, m.status)) throw new Error(`unknown mutant status ${m.status}`);
      counts[m.status]++;
    }
  }
  return counts;
}

/** Stryker's mutation score; Ignored, CompileError and RuntimeError mutants are not valid and do not count. */
export function scoreOf(counts) {
  const valid = validOf(counts);
  // Multiply before dividing: (57 / 100) * 1e4 is 5699.999... in floating point.
  return valid === 0 ? undefined : Math.floor(((counts.Killed + counts.Timeout) * 1e4) / valid) / 100;
}

export function survivorsOf(report, focus) {
  const wanted = focus.map(posix);
  const out = [];
  for (const [path, file] of Object.entries(report.files ?? {})) {
    const p = posix(path);
    if (!wanted.some((f) => p === f || p.endsWith('/' + f))) continue;
    for (const m of file.mutants) {
      if (m.status === 'Survived' || m.status === 'NoCoverage') out.push({ file: p, line: m.location.start.line, column: m.location.start.column, mutator: m.mutatorName, replacement: m.replacement ?? '', status: m.status });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
}

/**
 * `baselineEmpty`: no target has a score yet (before the first recorded baseline), so nothing is gated. Once the
 * baseline holds scores, a target without an entry fails: a new or split target is recorded from its first CI run.
 */
export function verdictOf(target, report, baselineEntry, tolerance, { baselineEmpty = false } = {}) {
  const name = target.name;
  if (report === undefined) return { name, pass: false, reason: 'no report: the mutation job of this target failed or timed out' };
  const counts = countsOf(report);
  if (counts.Pending > 0) return { name, counts, pass: false, reason: `${counts.Pending} mutants still pending: the run did not finish` };
  const score = scoreOf(counts);
  if (score === undefined) return { name, counts, pass: false, reason: 'no valid mutants: check the mutate globs of the config' };
  const survivors = survivorsOf(report, target.focus);
  if (baselineEntry === undefined && baselineEmpty) return { name, counts, score, survivors, pass: true, gated: false };
  if (baselineEntry === undefined) {
    return { name, counts, score, survivors, pass: false, reason: 'no baseline entry while baseline.json scores other targets: record its first CI score with update-baseline.mjs --run <id> (scripts/mutation/README.md, "The baseline")' };
  }
  const delta = Math.round((score - baselineEntry.score) * 100) / 100;
  const pass = delta >= -tolerance;
  const reason = pass ? undefined : `${fixed(-delta)} points below the baseline ${fixed(baselineEntry.score)}, more than the ${tolerance} allowed`;
  return { name, counts, score, survivors, baseline: baselineEntry.score, delta, pass, gated: true, ...(reason ? { reason } : {}) };
}

function rowOf(v) {
  const c = v.counts;
  const cells = c ? [validOf(c), c.Killed, c.Timeout, c.Survived, c.NoCoverage, c.Ignored, c.CompileError + c.RuntimeError] : Array(7).fill('-');
  const baseline = v.baseline !== undefined ? fixed(v.baseline) : v.score !== undefined ? 'no baseline' : '-';
  const change = v.delta === undefined ? '-' : `${v.delta >= 0 ? '+' : ''}${fixed(v.delta)}`;
  return `| ${v.name} | ${cells.join(' | ')} | ${fixed(v.score)} | ${baseline} | ${change} | ${v.pass ? (v.gated === false ? 'not gated: no baseline yet' : 'pass') : `**failed**: ${v.reason}`} |`;
}

function survivorLines(v) {
  if (!v.survivors?.length) return [];
  const line = (s) => `- \`${s.file}:${s.line}:${s.column}\` ${s.mutator} → \`${s.replacement.replace(/\s+/g, ' ').slice(0, 80)}\` (${s.status})`;
  const more = v.survivors.length > SURVIVOR_LINES ? [`- ${v.survivors.length - SURVIVOR_LINES} more in the report`] : [];
  return ['', `#### Survivors in ${v.name} (triage list, scripts/mutation/README.md)`, '', ...v.survivors.slice(0, SURVIVOR_LINES).map(line), ...more];
}

export function summaryOf(verdicts, { tolerance, measuredOn }) {
  return [
    '### Mutation gate',
    '',
    `Score = (killed + timeout) / (killed + timeout + survived + no coverage). A target fails when its score is more than ${tolerance} points below \`scripts/mutation/baseline.json\`.`,
    '',
    '| target | valid | killed | timeout | survived | no coverage | ignored | invalid | score | baseline | change | result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...verdicts.map(rowOf),
    '',
    measuredOn ? `Baseline measured ${measuredOn.date ?? '(no date)'} in ${measuredOn.runUrl ?? '(no run link)'}.` : 'The baseline holds no scores yet, so no target is gated (scripts/mutation/README.md, "The baseline").',
    ...verdicts.flatMap(survivorLines),
    '',
  ].join('\n');
}

export function baselineCandidate(verdicts, env, now) {
  const onCi = env.GITHUB_ACTIONS === 'true';
  const run = onCi ? { runUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`, repository: env.GITHUB_REPOSITORY, commit: env.GITHUB_SHA, ref: env.GITHUB_REF, event: env.GITHUB_EVENT_NAME } : {};
  const targets = Object.fromEntries(verdicts.filter((v) => v.score !== undefined).map((v) => [v.name, { score: v.score, valid: validOf(v.counts) }]));
  return { measuredOn: { ci: onCi ? 'github-actions' : 'local', ...run, date: now.toISOString() }, targets };
}

export const matrixOf = (config) => config.targets.map(({ name, package: pkg, config: file, concurrency }) => ({ name, package: pkg, config: file, concurrency }));

export function parseArgs(argv) {
  const o = { targets: join(HERE, 'targets.json'), baseline: join(HERE, 'baseline.json'), reportsDir: undefined, reportPairs: [], outDir: resolve('.stryker-tmp/gate'), matrix: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--targets') o.targets = resolve(argv[++i]);
    else if (arg === '--baseline') o.baseline = resolve(argv[++i]);
    else if (arg === '--reports') o.reportsDir = resolve(argv[++i]);
    else if (arg === '--report') {
      const m = /^([a-z0-9-]+)=(.+)$/.exec(argv[++i] ?? '');
      if (!m) throw new Error('--report needs <target>=<mutation.json>');
      o.reportPairs.push([m[1], resolve(m[2])]);
    } else if (arg === '--out-dir') o.outDir = resolve(argv[++i]);
    else if (arg === '--matrix') o.matrix = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (o.reportsDir && o.reportPairs.length) throw new Error('--reports and --report exclude each other');
  if (!o.matrix && !o.reportsDir && o.reportPairs.length === 0) throw new Error('pass --reports <dir> or --report <target>=<mutation.json>');
  return o;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** With --reports every target is expected (a missing report fails it); with --report only the named ones are checked. */
export function reportsOf(targets, { reportsDir, reportPairs }) {
  if (reportsDir) {
    return new Map(targets.map((t) => {
      const file = join(reportsDir, `mutation-${t.name}`, 'mutation.json');
      return [t.name, existsSync(file) ? readJson(file) : undefined];
    }));
  }
  const known = new Set(targets.map((t) => t.name));
  const out = new Map();
  for (const [name, file] of reportPairs) {
    if (!known.has(name)) throw new Error(`--report names ${name}, which targets.json does not list`);
    out.set(name, readJson(file));
  }
  return out;
}

function report(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const config = readTargets(o.targets);
  if (o.matrix) return void process.stdout.write(JSON.stringify(matrixOf(config)));
  const baseline = readBaseline(o.baseline);
  const reports = reportsOf(config.targets, o);
  const baselineEmpty = Object.keys(baseline.targets).length === 0;
  const verdicts = config.targets.filter((t) => reports.has(t.name)).map((t) => verdictOf(t, reports.get(t.name), baseline.targets[t.name], config.tolerance, { baselineEmpty }));
  report(summaryOf(verdicts, { tolerance: config.tolerance, measuredOn: baseline.measuredOn }));
  mkdirSync(o.outDir, { recursive: true });
  writeFileSync(join(o.outDir, CANDIDATE_FILE), JSON.stringify(baselineCandidate(verdicts, process.env, new Date()), null, 2) + '\n');
  const failed = verdicts.filter((v) => !v.pass);
  for (const v of failed) console.error(`mutation gate: ${v.name}: ${v.reason}`);
  process.exitCode = failed.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mutation gate could not run\n\n\`\`\`\n${message.slice(0, 4000)}\n\`\`\`\n`);
    process.exitCode = 1;
  }
}
