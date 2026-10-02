import { readdirSync } from 'node:fs';
import { inspect } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatTable, runScenario, type Scenario, type ScenarioResult } from './lib.js';

// Usage: npm run bench -- [--filter=scenario-substring] [--files=file-substring] [--repeats=3] [--scale=0.1]
// --files narrows which scenario files are imported at all: it keeps a 2.x file whose sources are
// gone, and its global DI side effects, out of a 3.0 run. A file that fails to import is skipped, but the run exits 1
// when --files was given or no scenario ran.
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'] as const;
  }),
);

const filter = args.get('filter');
const fileFilter = args.get('files');
const repeats = Number(args.get('repeats') ?? 3);
const scale = Number(args.get('scale') ?? 1);

const dir = join(dirname(fileURLToPath(import.meta.url)), 'scenarios');
const files = readdirSync(dir)
  .filter((f) => /\.(ts|mjs|js)$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('_') && (!fileFilter || f.includes(fileFilter)))
  .sort();

const scenarios: Scenario[] = [];
let importFailed = false;
for (const file of files) {
  try {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default: Scenario | Scenario[] };
    scenarios.push(...[mod.default].flat());
  } catch (err) {
    importFailed = true;
    console.warn(`skipped ${file}: failed to import (${(err as Error | undefined)?.message?.split(/\r?\n/)[0] ?? inspect(err, { depth: 1 })})`);
  }
}

if ((fileFilter && importFailed) || scenarios.length === 0) {
  console.error(scenarios.length === 0 ? 'no scenario ran' : 'a scenario file matched by --files failed to import');
  process.exit(1);
}

const selected = scenarios.filter((s) => !filter || s.name.includes(filter));
const results: ScenarioResult[] = [];

try {
  for (const scenario of selected) {
    process.stdout.write(`running ${scenario.name} ...\n`);
    results.push(await runScenario(scenario, { repeats, scale }));
  }

  console.log(`\nrepeats=${repeats} (headline = median over repeats), scale=${scale}`);
  console.log(formatTable(results));
  process.exit(0);
} catch (err) {
  // ts-node/esm swallows a rejected top-level await into a silent exit 0
  console.error(err);
  process.exit(1);
}
