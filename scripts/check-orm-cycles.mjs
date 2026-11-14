#!/usr/bin/env node
/**
 * Fails when .dependency-cruiser-known-violations.json lists a `no-circular` violation under
 * packages/orm/src/. `npm run deps` ignores known violations, so without this check a regenerated
 * baseline could let an orm import cycle back in. Exit codes: 0 none, 1 at least one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORM = 'packages/orm/src/';

/** The `no-circular` entries of a dependency-cruiser baseline whose `from` lies under packages/orm/src/. */
export function ormCycles(violations) {
  return violations.filter((v) => v.rule.name === 'no-circular' && v.from.startsWith(ORM));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseline = new URL('../.dependency-cruiser-known-violations.json', import.meta.url);
  const cycles = ormCycles(JSON.parse(readFileSync(baseline, 'utf8')));
  for (const c of cycles) console.error(`  ${c.cycle.map((s) => s.name).join(' > ')}`);
  console.log(`check-orm-cycles: ${cycles.length} no-circular entr${cycles.length === 1 ? 'y' : 'ies'} under ${ORM} in the dependency-cruiser baseline`);
  process.exit(cycles.length > 0 ? 1 : 0);
}
