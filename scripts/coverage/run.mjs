/**
 * Coverage of the whole monorepo in one report, plus which tests run which source lines.
 * Runs every package's `npm test` with node's V8 coverage on and scripts/coverage/per-test-hook.cjs
 * preloaded, then `c8 report` over all of it and scripts/coverage/per-test-report.mjs over the per-test
 * data. Build first ( `npm run build` ): packages import each other through the built lib/, and the
 * package pretest scripts that would rebuild it are skipped.
 *
 * Packages listed in scripts/coverage/local-only.json need external services ( databases, queues, cloud
 * APIs ). They run locally and are skipped with --ci ( or CI=true ), and then left out of the report too.
 *
 * Usage
 * -----
 *   node scripts/coverage/run.mjs                 every package with a test script
 *   node scripts/coverage/run.mjs util http       only these
 *   node scripts/coverage/run.mjs --ci            skip the local-only packages
 *   node scripts/coverage/run.mjs --strict        exit 1 when a test suite fails ( implied by --ci; scripts/known-failing.json is tolerated )
 *   node scripts/coverage/run.mjs --report-only   rebuild the report from the last run's coverage/
 *
 * Output in coverage/: index.html, lcov.info, coverage-summary.json, summary.md, per-test-report.json.
 * summary.md is also appended to $GITHUB_STEP_SUMMARY when set.
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { analyzePerTest } from './per-test-report.mjs';
import { loadKnownFailing, loadTimeouts, timeoutMinutes } from '../test-all.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT = join(ROOT, 'coverage');
const ARGS = process.argv.slice(2);
const CI = ARGS.includes('--ci') || process.env.CI === 'true';
const STRICT = ARGS.includes('--strict') || CI;
const KNOWN_FAILING = loadKnownFailing();
const TIMEOUTS = loadTimeouts();
const REPORT_ONLY = ARGS.includes('--report-only');
const ONLY = ARGS.filter((a) => !a.startsWith('--'));
const LOCAL_ONLY = JSON.parse(readFileSync(join(import.meta.dirname, 'local-only.json'), 'utf8')).packages;
const C8 = createRequire(import.meta.url).resolve('c8/bin/c8.js');
const HOOK = join(import.meta.dirname, 'per-test-hook.cjs').replaceAll('\\', '/');

const packages = readdirSync(join(ROOT, 'packages'))
  .filter((name) => ONLY.length === 0 || ONLY.includes(name))
  .filter((name) => existsSync(join(ROOT, 'packages', name, 'package.json')))
  .filter((name) => JSON.parse(readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8')).scripts?.test);

const skipped = CI ? packages.filter((name) => LOCAL_ONLY.includes(name)) : [];
const results = REPORT_ONLY ? JSON.parse(readFileSync(join(OUT, 'suites.json'), 'utf8')) : [];

if (!REPORT_ONLY) rmSync(OUT, { recursive: true, force: true });

const env = {
  ...process.env,
  NODE_V8_COVERAGE: join(OUT, 'tmp'),
  SPINAJS_PER_TEST_COVERAGE: join(OUT, 'per-test'),
  SPINAJS_COVERAGE_ROOT: ROOT,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${HOOK}"`.trim(),
};

for (const name of REPORT_ONLY ? [] : packages) {
  if (skipped.includes(name)) continue;
  console.log(`\n=== ${name}`);
  const started = Date.now();
  // Skips the pretest scripts: each recompiles what the root build already built, minutes per package.
  const run = spawnSync('npm', ['test', '--ignore-scripts'], { cwd: join(ROOT, 'packages', name), env, stdio: 'inherit', shell: true, timeout: timeoutMinutes(name, TIMEOUTS) * 60000, killSignal: 'SIGKILL' });
  results.push({ name, ok: run.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
  writeFileSync(join(OUT, 'suites.json'), JSON.stringify(results));
}
const failed = results.filter((r) => !r.ok);
const blocking = failed.filter((r) => !KNOWN_FAILING.has(r.name));
for (const r of failed.filter((r) => KNOWN_FAILING.has(r.name))) console.warn(`WARNING: ${r.name} failed but is listed in scripts/known-failing.json`);
for (const r of results.filter((r) => r.ok && KNOWN_FAILING.has(r.name))) console.warn(`${r.name} passes now: remove from known-failing.json`);

const c8Config = JSON.parse(readFileSync(join(ROOT, '.c8rc.json'), 'utf8'));
const notMeasured = [...skipped, ...readdirSync(join(ROOT, 'packages')).filter((name) => ONLY.length > 0 && !ONLY.includes(name))];
const exclude = [...(c8Config.exclude ?? []), ...notMeasured.map((name) => `packages/${name}/**`)];
spawnSync(process.execPath, [C8, 'report', '--reporter=html', '--reporter=lcov', '--reporter=json-summary', '--reporter=text-summary', ...exclude.map((e) => `--exclude=${e}`)], {
  cwd: ROOT,
  stdio: 'inherit',
});

const perTest = analyzePerTest(ROOT, OUT);
writeFileSync(join(OUT, 'per-test-report.json'), JSON.stringify(perTest.report, null, 2));

const markdown = summary(JSON.parse(readFileSync(join(OUT, 'coverage-summary.json'), 'utf8')), perTest.markdown);
writeFileSync(join(OUT, 'summary.md'), markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

console.log(`\n${results.length - failed.length}/${results.length} test suites passed. Report: coverage/index.html, coverage/summary.md`);
if (STRICT && blocking.length) process.exit(1);

function summary(c8Summary, perTestMarkdown) {
  const byPackage = new Map();
  for (const [file, metrics] of Object.entries(c8Summary)) {
    const name = /[\\/]packages[\\/]([^\\/]+)[\\/]/.exec(file)?.[1];
    if (!name) continue;
    const acc = byPackage.get(name) ?? { lines: [0, 0], branches: [0, 0], functions: [0, 0] };
    for (const key of ['lines', 'branches', 'functions']) {
      acc[key][0] += metrics[key].covered;
      acc[key][1] += metrics[key].total;
    }
    byPackage.set(name, acc);
  }
  const pct = ([covered, total]) => (total === 0 ? '–' : `${((covered / total) * 100).toFixed(1)}%`);
  const suite = new Map(results.map((r) => [r.name, r]));
  const t = c8Summary.total;

  const lines = [
    '## Test coverage',
    '',
    `**Lines ${t.lines.pct}%** · branches ${t.branches.pct}% · functions ${t.functions.pct}% · ${results.length - failed.length}/${results.length} test suites passed`,
    '',
  ];
  if (failed.length) lines.push(`Failed suites (their coverage is partial): ${failed.map((r) => `\`${r.name}\``).join(', ')}`, '');
  if (skipped.length) lines.push(`Local only, not measured here (need external services): ${skipped.map((n) => `\`${n}\``).join(', ')}`, '');
  lines.push('<details><summary>Per package</summary>', '', '| Package | Lines | Branches | Functions | Suite |', '| --- | ---: | ---: | ---: | --- |');
  for (const [name, acc] of [...byPackage].sort(([a], [b]) => a.localeCompare(b))) {
    const r = suite.get(name);
    lines.push(`| ${name} | ${pct(acc.lines)} | ${pct(acc.branches)} | ${pct(acc.functions)} | ${r ? (r.ok ? 'passed' : '**failed**') + ` ( ${r.seconds}s )` : 'no tests'} |`);
  }
  lines.push('', '</details>', '', perTestMarkdown, '');
  return lines.join('\n');
}
