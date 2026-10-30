#!/usr/bin/env node
import { existsSync } from 'node:fs';
import path from 'node:path';
import { analyzePackage, DEFAULT_RULES } from '@spinajs/compiler';

const [dir, ...rest] = process.argv.slice(2);
if (!dir) {
  console.error('usage: report-diagnostics.mjs <packageDir> [--fail-on CODE,...]');
  process.exit(2);
}
const failOn = rest.includes('--fail-on') ? (rest[rest.indexOf('--fail-on') + 1] ?? '').split(',').filter(Boolean) : [];
const packageRoot = path.resolve(dir);
const tsconfig = path.join(packageRoot, 'tsconfig.build.json');
if (!existsSync(tsconfig)) {
  console.error(`no tsconfig.build.json in ${packageRoot}`);
  process.exit(2);
}

const fragment = await analyzePackage({ tsconfig, packageRoot, schemaDerivation: true });
// SCH003 is a doctor rule that only reads manifest.schemas, so a one-package manifest is enough.
const drift = DEFAULT_RULES.find((rule) => rule.code === 'SCH003').run({ schemas: fragment.schemas }, {});
const sorted = [...fragment.diagnostics, ...drift].sort((a, b) => a.code.localeCompare(b.code) || (a.source?.file ?? '').localeCompare(b.source?.file ?? ''));
for (const d of sorted) console.log(`${d.severity} ${d.code} ${d.source ? `${d.source.file}:${d.source.line}` : '-'} ${d.message}`);

const counts = {};
for (const d of sorted) {
  counts[d.code] ??= {};
  counts[d.code][d.severity] = (counts[d.code][d.severity] ?? 0) + 1;
}
console.log(JSON.stringify(counts));

// A bare wrapper return (e.g. `Ok`) has no schema and is not a diagnostic.
const routesWithoutSchema = fragment.controllers.flatMap((c) => c.routes).filter((r) => !r.returnType.schema).length;
console.log(JSON.stringify({ routesWithoutSchema }));
// `info` marks a deliberate opaque value (`unknown`), so it never fails the gate.
process.exit(failOn.some((code) => sorted.some((d) => d.code === code && d.severity !== 'info')) ? 1 : 0);
