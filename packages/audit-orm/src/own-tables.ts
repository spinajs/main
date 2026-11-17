import { AuditConfigError, AuditStore, trailConfig, trailNames } from '@spinajs/audit';
import type { TrailConfig } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';

import { findConnection } from './rows.js';

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

const quoted = (v: string): string => JSON.stringify(v);

// A table trail's table can hold events on any connection; an archive is the trail's table on its archive connection.
interface Claim {
  readonly trail: string;
  readonly table: string;
  readonly archive: string | undefined;
}

const collide = (a: Claim, b: Claim): boolean => a.table === b.table && (a.archive === undefined || b.archive === undefined || a.archive === b.archive);

function refusal(owner: Claim, claim: Claim): string {
  const archived = claim.archive === undefined ? owner : claim;
  let where = '';
  if (owner.archive !== undefined && claim.archive !== undefined) where = ` (their archives on connection ${quoted(claim.archive)})`;
  else if (archived.archive !== undefined) where = ` (the archive of ${quoted(archived.trail)} on connection ${quoted(archived.archive)})`;
  return `audit: trails ${quoted(owner.trail)} and ${quoted(claim.trail)} both use table ${quoted(claim.table)}${where}; give each trail its own table`;
}

function claimsOf(trail: TrailConfig, registered: readonly unknown[], tableStore: Class<AuditStore>): Claim[] {
  const claims: Claim[] = [];
  if (isTableStore(trail.store, registered, tableStore)) claims.push({ trail: trail.name, table: trail.table, archive: undefined });
  if (trail.archiveConnection !== undefined) claims.push({ trail: trail.name, table: trail.table, archive: findConnection(trail.archiveConnection)?.Options.Name ?? trail.archiveConnection });
  return claims;
}

// The later trail of two is refused, so the trail that owned the table first keeps working.
function refusalsOf(registered: readonly unknown[], tableStore: Class<AuditStore>): Map<string, string> {
  const owned: Claim[] = [];
  const refusals = new Map<string, string>();
  for (const name of trailNames()) {
    const trail = configOf(name);
    const claims = trail === undefined ? [] : claimsOf(trail, registered, tableStore);
    const clash = claims.flatMap((claim) => owned.filter((o) => collide(o, claim)).map((o) => refusal(o, claim)))[0];
    if (clash === undefined) owned.push(...claims);
    else refusals.set(name, clash);
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
