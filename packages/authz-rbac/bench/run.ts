import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatTable, runScenario } from './lib.js';
import type { BenchScenario, ScenarioResult } from './lib.js';

// Usage (from packages/authz-rbac): npm run bench -- [--filter=substring] [--repeats=n] [--scale=x]
// As the kit's bench/run.ts, plus: a scenario may set its own repeats (--repeats overrides them all), a module may
// export `dispose` (run at the end) and `info` (printed), and the table of release gate 7 is printed last.
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'] as const;
  }),
);
const filter = args.get('filter');
const repeats = args.has('repeats') ? Number(args.get('repeats')) : undefined;
const scale = Number(args.get('scale') ?? 1);

interface ScenarioModule {
  default: BenchScenario | BenchScenario[];
  dispose?(): Promise<void>;
  info?(): Promise<Record<string, unknown>>;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const files = readdirSync(dir)
  .filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('_'))
  .sort();

const modules: ScenarioModule[] = [];
const scenarios: BenchScenario[] = [];
for (const file of files) {
  const mod = (await import(pathToFileURL(join(dir, file)).href)) as ScenarioModule;
  modules.push(mod);
  scenarios.push(...[mod.default].flat());
}

const fmt = (ns: number) => (ns / 1e6).toFixed(ns < 1e7 ? 2 : 1);

/** Release gate 7: each scenario with a `compare` against it, p50 and p99 ratios, pass at ≤ 2. */
function gateTable(results: readonly ScenarioResult[]): string {
  const byName = new Map(results.map((r) => [r.name, r]));
  const rows = results.flatMap((r) => {
    const base = r.compare ? byName.get(r.compare) : undefined;
    if (!base) return [];
    const p50 = r.p50 / base.p50;
    const p99 = r.p99 / base.p99;
    return [[r.name, fmt(r.p50), fmt(base.p50), p50.toFixed(2), fmt(r.p99), fmt(base.p99), p99.toFixed(2), p50 <= 2 && p99 <= 2 ? 'pass' : 'FAIL']];
  });
  const header = ['scenario (a) vs its compare (b)', 'a p50 ms', 'b p50 ms', 'p50 a/b', 'a p99 ms', 'b p99 ms', 'p99 a/b', 'gate ≤ 2'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const selected = scenarios.filter((s) => !filter || s.name.includes(filter));
const results: ScenarioResult[] = [];
let failed = false;
try {
  for (const scenario of selected) {
    process.stdout.write(`running ${scenario.name} ...\n`);
    results.push(await runScenario(scenario, { repeats: repeats ?? scenario.repeats ?? 3, scale }));
  }
  for (const m of modules) if (m.info) console.log(JSON.stringify(await m.info(), null, 1));
  console.log(`\nrepeats=${repeats ?? 'per scenario'} (headline = median over repeats), scale=${scale}`);
  console.log(formatTable(results));
  console.log(`\n${gateTable(results)}`);
} catch (err) {
  // ts-node/esm swallows a rejected top-level await into a silent exit 0
  console.error(err);
  failed = true;
} finally {
  for (const m of modules) await m.dispose?.();
}
process.exit(failed ? 1 : 0);
