import { AuditConfigError, AuditStore, trailConfig, trailNames } from '@spinajs/audit';
import type { TrailConfig } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';

// One entry: the configuration and the registrations it was computed from, and the refusal per colliding trail.
let cached: { readonly key: string; readonly refusals: ReadonlyMap<string, string> } | undefined;

function configOf(name: string): TrailConfig | undefined {
  try {
    return trailConfig(name);
  } catch {
    // An invalid trail fails where it is used, not on every other trail.
    return undefined;
  }
}

// Decided from the registration, so the check creates no store.
function isTableStore(store: string, registered: readonly unknown[], tableStore: Class<AuditStore>): boolean {
  const type = [...registered].reverse().find((t): t is object => typeof t === 'function' && t.name === store);
  return type !== undefined && (type === tableStore || Object.prototype.isPrototypeOf.call(tableStore, type));
}

function refusalsOf(registered: readonly unknown[], tableStore: Class<AuditStore>): Map<string, string> {
  const owners = new Map<string, string>();
  const refusals = new Map<string, string>();
  for (const name of trailNames()) {
    const trail = configOf(name);
    if (trail === undefined || !isTableStore(trail.store, registered, tableStore)) continue;
    const owner = owners.get(trail.table);
    if (owner === undefined) {
      owners.set(trail.table, name);
      continue;
    }
    const message = `audit: trails ${JSON.stringify(owner)} and ${JSON.stringify(name)} both use table ${JSON.stringify(trail.table)}; give each trail its own table`;
    if (!refusals.has(owner)) refusals.set(owner, message);
    refusals.set(name, message);
  }
  return refusals;
}

/**
 * Refuses a trail of a table store whose table another such trail uses (design D10): a trail table has no trail column,
 * and its events may sit on any connection, so retention and reads of one trail would reach the other's. Only the
 * colliding trails are refused. Recomputed when the configured trails or the registered stores change: the signature is
 * the configuration's JSON, because `Configuration.set` changes `audit.trails` in place.
 */
export function assertOwnTable(trail: TrailConfig, tableStore: Class<AuditStore>): void {
  const registered: readonly unknown[] = DI.RootContainer.getRegisteredTypes(AuditStore);
  const key = `${JSON.stringify(DI.get(Configuration)?.get<unknown>(['audit', 'trails']) ?? null)}\n${registered.map((t) => (typeof t === 'function' ? t.name : '')).join(',')}`;
  if (cached?.key !== key) cached = { key, refusals: refusalsOf(registered, tableStore) };
  const refusal = cached.refusals.get(trail.name);
  if (refusal !== undefined) throw new AuditConfigError(refusal);
}
