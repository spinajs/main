#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export function findEngineDrift(rootEngines, packages) {
  const expected = rootEngines?.node;
  return packages.filter((p) => p.engines?.node !== expected).map((p) => ({ name: p.name, engines: p.engines?.node }));
}

function main() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (!root.engines?.node) {
    console.error('root package.json has no engines.node');
    process.exit(1);
  }
  const packages = readdirSync(join(ROOT, 'packages'))
    .map((d) => join(ROOT, 'packages', d, 'package.json'))
    .filter((f) => existsSync(f))
    .map((f) => JSON.parse(readFileSync(f, 'utf8')));
  const drift = findEngineDrift(root.engines, packages);
  for (const d of drift) console.error(`engines drift: ${d.name} has ${d.engines ?? 'none'}, root has ${root.engines.node}`);
  console.log(`${packages.length - drift.length}/${packages.length} packages declare engines.node ${root.engines.node}`);
  process.exit(drift.length ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
