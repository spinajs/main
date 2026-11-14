import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest, SqlDialectProfile } from '@spinajs/manifest';

type Installed = Pick<Manifest, 'sqlDialects'>;

/** No installed driver declares the connection's dialect: every type that depends on the driver is `unknown`. */
export const GENERIC_SQL_DIALECT: SqlDialectProfile = {
  name: 'generic',
  grammar: 'MySQL',
  placeholders: 'question',
  families: { bigint: 'unknown', decimal: 'unknown', boolean: 'unknown', date: 'unknown', datetime: 'unknown', time: 'unknown', json: 'unknown' },
  count: 'unknown',
  sum: {},
  avg: {},
  predicates: 'unknown',
};

/** By profile name or driver token; the last fragment wins, as the app's own DI registration does. */
export function findSqlDialect(manifest: Installed, nameOrDriver: string): SqlDialectProfile | undefined {
  const entries = manifest.sqlDialects ?? [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].profile.name === nameOrDriver || entries[i].drivers.includes(nameOrDriver)) return entries[i].profile;
  }
  return undefined;
}

/** A named dialect or driver that is not installed never falls back to the only installed one: that would be a guess. */
export function resolveSqlDialect(manifest: Installed, declared?: string, driver?: string): SqlDialectProfile | undefined {
  if (declared) return findSqlDialect(manifest, declared);
  if (driver) return findSqlDialect(manifest, driver);
  const names = [...new Set((manifest.sqlDialects ?? []).map((d) => d.profile.name))];
  return names.length === 1 ? findSqlDialect(manifest, names[0]) : undefined;
}

/** `package.json#spinajs.orm.dialects` of the app (D6): connection name to a profile name or driver token. */
export function readSqlDialects(appRoot: string): Record<string, string> {
  const file = join(appRoot, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { spinajs?: { orm?: { dialects?: Record<string, unknown> } } };
    return Object.fromEntries(Object.entries(pkg.spinajs?.orm?.dialects ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}
