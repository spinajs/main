import { randomUUID } from 'node:crypto';
import { AuthzConfigError, SCOPE_ATTRIBUTE_LIMITS, WritableScopeAttributeStore, principalKey, underPath, unflattenAttributes } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef, ScopeAttributeLeaf } from '@spinajs/authz';
import { DateTime } from 'luxon';

import { requireTransaction, selectFrom } from '../records.js';
import { SCOPE_ATTRIBUTE_TABLE, SCOPE_ATTRIBUTE_VERSION_TABLE, ScopeAttributeRecord, ScopeAttributeVersionRecord } from './records.js';

// value_text varchar(255); value_num decimal(20,6) holds 14 digits before the point.
const TEXT_MAX = 255;
const NUM_MAX = 1e14;
const KEY_MAX = 64;
const BY_MAX = 100;

/** Every scalar as text, so SQL can compare value_text alone (design §12.4 reads only that column). */
function textOf(v: ScopeAttributeLeaf): string | null {
  if (typeof v === 'string') return v.length <= TEXT_MAX ? v : null;
  return typeof v === 'boolean' ? String(v) : JSON.stringify(v);
}

const isLeaf = (v: unknown): v is ScopeAttributeLeaf => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/** A row as the driver returns it: value_json still the text the column holds. */
interface StoredLeaf {
  readonly path: string;
  readonly value_json: unknown;
}

function leafOf(row: StoredLeaf): ScopeAttributeLeaf {
  let v: unknown;
  try {
    v = typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json;
  } catch (err) {
    throw new AuthzConfigError(`${SCOPE_ATTRIBUTE_TABLE} row ${JSON.stringify(row.path)}: value_json holds ${JSON.stringify(row.value_json)}, not JSON`, { cause: err });
  }
  if (!isLeaf(v)) throw new AuthzConfigError(`${SCOPE_ATTRIBUTE_TABLE} row ${JSON.stringify(row.path)}: value_json holds ${JSON.stringify(v)}, not a scalar`);
  return v;
}

/**
 * Scope attributes in table authz_scope_attribute (migration AuthzScopeAttribute_2026_10_02_00_00_00), on the
 * connection db.Aliases.authz names. Not registered by default: register one instance under both
 * ScopeAttributeStore and WritableScopeAttributeStore. Writes run only inside the ORM transaction of an
 * AuthzAdmin batch (AuthzTx.driver) on that connection.
 */
export class DbScopeAttributeStore extends WritableScopeAttributeStore {
  async get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    return unflattenAttributes(await this.rows(ref));
  }

  /** The one row of authz_scope_attribute_version; every write gives it a fresh id inside the write's transaction. */
  async version(): Promise<string> {
    const row = (await selectFrom(ScopeAttributeVersionRecord).where('id', 1).first()) as ScopeAttributeVersionRecord | undefined;
    return row ? row.version : '0';
  }

  async rows(ref: ResourceRef): Promise<Readonly<Record<string, ScopeAttributeLeaf>>> {
    const key = keyOf(ref);
    const out: Record<string, ScopeAttributeLeaf> = {};
    if (!fits(key)) return out;
    for (const r of await this.select(key)) out[r.path] = leafOf(r);
    return out;
  }

  async write(ref: ResourceRef, change: { readonly set: Readonly<Record<string, ScopeAttributeLeaf>>; readonly remove: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<number> {
    requireTransaction(ScopeAttributeRecord, tx, 'DbScopeAttributeStore.write');
    const key = keyOf(ref);
    if (!fits(key)) throw new AuthzConfigError(`DbScopeAttributeStore: ${JSON.stringify(ref)} does not fit ${SCOPE_ATTRIBUTE_TABLE}.scope_type/scope_id (${KEY_MAX} characters each)`);
    const set = Object.entries(change?.set ?? {});
    const remove = [...(change?.remove ?? [])];
    for (const [path, v] of set) {
      if (path === '' || path.length > SCOPE_ATTRIBUTE_LIMITS.path) throw new AuthzConfigError(`DbScopeAttributeStore: path ${JSON.stringify(path)} does not fit ${SCOPE_ATTRIBUTE_TABLE}.path`);
      if (!isLeaf(v)) throw new AuthzConfigError(`DbScopeAttributeStore: ${JSON.stringify(path)} holds ${String(v)}, not a scalar`);
      if (JSON.stringify(v).length > SCOPE_ATTRIBUTE_LIMITS.json) throw new AuthzConfigError(`DbScopeAttributeStore: the value at ${JSON.stringify(path)} does not fit ${SCOPE_ATTRIBUTE_TABLE}.value_json`);
    }
    if (!remove.every((p) => typeof p === 'string' && p !== '')) throw new AuthzConfigError('DbScopeAttributeStore: remove must list paths');

    await this.bump();
    const existing = (await this.select(key)).map((r) => r.path);
    const setPaths = set.map(([p]) => p);
    // A set path also drops the rows above and below it, so the node always forms one object.
    const removed = existing.filter((p) => remove.some((r) => underPath(p, r)) || setPaths.some((s) => s !== p && (underPath(p, s) || underPath(s, p))));
    const replaced = setPaths.filter((p) => existing.includes(p));
    const doomed = [...new Set([...removed, ...replaced])];
    if (doomed.length > 0) await ScopeAttributeRecord.destroy().where(key).whereIn('path', doomed);
    const updated_at = DateTime.now();
    const updated_by = principalKey(actor).slice(0, BY_MAX);
    await ScopeAttributeRecord.insert(set.map(([path, v]) => ({ ...key, path, value_json: v, value_text: textOf(v), value_num: typeof v === 'number' && Math.abs(v) < NUM_MAX ? v : null, updated_by, updated_at })));
    return removed.length + set.length;
  }

  async forget(ref: ResourceRef, tx: AuthzTx): Promise<number> {
    requireTransaction(ScopeAttributeRecord, tx, 'DbScopeAttributeStore.forget');
    const key = keyOf(ref);
    if (!fits(key)) return 0;
    await this.bump();
    const { RowsAffected } = await ScopeAttributeRecord.destroy().where(key);
    return RowsAffected;
  }

  // Raw rows: the @Json converter would fail the whole read on one row whose value_json is not JSON, with no path to name.
  private async select(key: Key): Promise<StoredLeaf[]> {
    return await selectFrom(ScopeAttributeRecord).columns(['path', 'value_json']).where(key).asRaw<StoredLeaf[]>();
  }

  /**
   * One UPDATE of the version row, and the first statement of every write and forget: its row lock queues
   * concurrent writers, so each one reads the node only after the one before it committed. Reading first
   * would let two writers under read-committed isolation delete and re-insert the same path, and the
   * second insert would fail on the primary key.
   */
  private async bump(): Promise<void> {
    const { RowsAffected } = await ScopeAttributeVersionRecord.update({ version: randomUUID(), updated_at: DateTime.now() }).where('id', 1);
    if (RowsAffected === 0) throw new AuthzConfigError(`DbScopeAttributeStore: ${SCOPE_ATTRIBUTE_VERSION_TABLE} has no row; run migration AuthzScopeAttribute_2026_10_02_00_00_00`);
  }
}

interface Key {
  readonly scope_type: string;
  readonly scope_id: string;
}

function keyOf(ref: ResourceRef): Key {
  if (ref === null || typeof ref !== 'object' || typeof ref.type !== 'string' || ref.type === '' || (ref.id != null && typeof ref.id !== 'string')) throw new AuthzConfigError(`DbScopeAttributeStore needs a resource ref, got ${JSON.stringify(ref)}`);
  return { scope_type: ref.type, scope_id: ref.id ?? '' };
}

/** A node whose key does not fit the columns cannot hold rows: reads answer empty, only a write is an error. */
const fits = (key: Key): boolean => key.scope_type.length <= KEY_MAX && key.scope_id.length <= KEY_MAX;
