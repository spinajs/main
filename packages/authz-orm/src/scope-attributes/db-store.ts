import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { CONFIGURATION_CONTAINER_KEY, Config } from '@spinajs/configuration';
import { Orm, OrmDriver } from '@spinajs/orm';
import { AuthzConfigError, SCOPE_ATTRIBUTE_LIMITS, WritableScopeAttributeStore, parseAttributeLeaf, principalKey, underPath, unflattenAttributes } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef, ScopeAttributeLeaf } from '@spinajs/authz';

const TABLE = 'authz_scope_attribute';
const VERSION_TABLE = 'authz_scope_attribute_version';
const CONNECTION_KEY = 'authz.admin.connection';
// value_text varchar(255); value_num decimal(20,6) holds 14 digits before the point.
const TEXT_MAX = 255;
const NUM_MAX = 1e14;
const KEY_MAX = 64;
const BY_MAX = 100;
// Rows per statement: 8 parameters a row stays under MSSQL's 2100 parameters and every driver's row limits.
const INSERT_CHUNK = 100;
const DELETE_CHUNK = 500;

const chunks = <T>(list: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/** Every scalar as text, so SQL can compare value_text alone (design §12.4 reads only that column). */
function textOf(v: ScopeAttributeLeaf): string | null {
  if (typeof v === 'string') return v.length <= TEXT_MAX ? v : null;
  return typeof v === 'boolean' ? String(v) : JSON.stringify(v);
}

interface Row {
  readonly path: string;
  readonly value_json: string;
}

export interface DbScopeAttributeStoreOptions {
  /** The ORM connection reads use; default: config authz.admin.connection. */
  readonly connection?: string;
  /** Where Configuration and Orm are resolved; default the DI root. */
  readonly container?: IContainer;
}

const isLeaf = (v: unknown): v is ScopeAttributeLeaf => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));

/**
 * Scope attributes in table authz_scope_attribute (migration AuthzScopeAttribute_2026_10_02_00_00_00). Not
 * registered by default: register one instance under both ScopeAttributeStore and WritableScopeAttributeStore.
 * Writes run only inside the ORM transaction of an AuthzAdmin batch (AuthzTx.driver).
 */
export class DbScopeAttributeStore extends WritableScopeAttributeStore {
  @Config(CONNECTION_KEY)
  protected Connection: string;

  constructor(private readonly opts: DbScopeAttributeStoreOptions = {}) {
    super();
    // Built with `new` for a container, it reads that container's Configuration, as when DI builds it there.
    if (opts.container) (this as unknown as Record<string, unknown>)[CONFIGURATION_CONTAINER_KEY] = opts.container;
  }

  async get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    return unflattenAttributes(await this.rows(ref));
  }

  /** The one row of authz_scope_attribute_version; every write gives it a fresh id inside the write's transaction. */
  async version(): Promise<string> {
    const driver = await this.reader();
    const rows = ((await driver.select().from(VERSION_TABLE).columns(['version']).where({ id: 1 })) ?? []) as { version: string }[];
    return rows[0] ? String(rows[0].version) : '0';
  }

  async rows(ref: ResourceRef): Promise<Readonly<Record<string, ScopeAttributeLeaf>>> {
    const key = keyOf(ref);
    const out: Record<string, ScopeAttributeLeaf> = {};
    if (!fits(key)) return out;
    for (const r of await this.select(await this.reader(), key)) out[r.path] = parseAttributeLeaf(r.value_json, `${TABLE} row ${JSON.stringify(r.path)}`);
    return out;
  }

  async write(ref: ResourceRef, change: { readonly set: Readonly<Record<string, ScopeAttributeLeaf>>; readonly remove: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<number> {
    const driver = await this.writer(tx);
    const key = keyOf(ref);
    if (!fits(key)) throw new AuthzConfigError(`DbScopeAttributeStore: ${JSON.stringify(ref)} does not fit ${TABLE}.scope_type/scope_id (${KEY_MAX} characters each)`);
    const set = Object.entries(change?.set ?? {});
    const remove = [...(change?.remove ?? [])];
    for (const [path, v] of set) {
      if (path === '' || path.length > SCOPE_ATTRIBUTE_LIMITS.path) throw new AuthzConfigError(`DbScopeAttributeStore: path ${JSON.stringify(path)} does not fit ${TABLE}.path`);
      if (!isLeaf(v)) throw new AuthzConfigError(`DbScopeAttributeStore: ${JSON.stringify(path)} holds ${String(v)}, not a scalar`);
      if (JSON.stringify(v).length > SCOPE_ATTRIBUTE_LIMITS.json) throw new AuthzConfigError(`DbScopeAttributeStore: the value at ${JSON.stringify(path)} does not fit ${TABLE}.value_json`);
    }
    if (!remove.every((p) => typeof p === 'string' && p !== '')) throw new AuthzConfigError('DbScopeAttributeStore: remove must list paths');

    await this.bump(driver);
    const existing = (await this.select(driver, key)).map((r) => r.path);
    const setPaths = set.map(([p]) => p);
    // A set path also drops the rows above and below it, so the node always forms one object.
    const removed = existing.filter((p) => remove.some((r) => underPath(p, r)) || setPaths.some((s) => s !== p && (underPath(p, s) || underPath(s, p))));
    const replaced = setPaths.filter((p) => existing.includes(p));
    const doomed = [...new Set([...removed, ...replaced])];
    for (const part of chunks(doomed, DELETE_CHUNK)) await driver.del().from(TABLE).where(key).whereIn('path', part);
    const now = new Date();
    const by = principalKey(actor).slice(0, BY_MAX);
    const rows = set.map(([path, v]) => ({ ...key, path, value_json: JSON.stringify(v), value_text: textOf(v), value_num: typeof v === 'number' && Math.abs(v) < NUM_MAX ? v : null, updated_by: by, updated_at: now }));
    for (const part of chunks(rows, INSERT_CHUNK)) await driver.insert().into(TABLE).values(part);
    return removed.length + set.length;
  }

  async forget(ref: ResourceRef, tx: AuthzTx): Promise<number> {
    const driver = await this.writer(tx);
    const key = keyOf(ref);
    if (!fits(key)) return 0;
    await this.bump(driver);
    const count = (await this.select(driver, key)).length;
    if (count > 0) await driver.del().from(TABLE).where(key);
    return count;
  }

  private async select(driver: OrmDriver, key: Key): Promise<Row[]> {
    return ((await driver.select().from(TABLE).columns(['path', 'value_json']).where(key)) ?? []) as Row[];
  }

  /**
   * One UPDATE of the version row, and the first statement of every write and forget: its row lock queues
   * concurrent writers, so each one reads the node only after the one before it committed. Under PostgreSQL
   * READ COMMITTED, reading first would let two writers delete and re-insert the same path, and the second
   * insert would fail on the primary key.
   */
  private async bump(driver: OrmDriver): Promise<void> {
    const values = { version: randomUUID(), updated_at: new Date() };
    const out = (await driver.update().in(VERSION_TABLE).update(values).where({ id: 1 })) as { RowsAffected?: number } | undefined;
    if (!out?.RowsAffected) throw new AuthzConfigError(`DbScopeAttributeStore: ${VERSION_TABLE} has no row; run migration AuthzScopeAttribute_2026_10_02_00_00_00`);
  }

  private async writer(tx: AuthzTx): Promise<OrmDriver> {
    const driver = (tx as AuthzTx | undefined)?.driver;
    if (!(driver instanceof OrmDriver) || driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError('DbScopeAttributeStore writes only inside an ORM transaction: AuthzTx.driver must be the OrmDriver of the running transaction (authz.admin.backend must be a DB backend)');
    }
    // Reads must see the batch's earlier writes, so they have to run on the transaction's connection.
    if (driver !== (await this.reader())) throw new AuthzConfigError(`DbScopeAttributeStore: the transaction runs on another connection than the one ${CONNECTION_KEY} names`);
    return driver;
  }

  private async reader(): Promise<OrmDriver> {
    const container = this.opts.container ?? DI.RootContainer;
    const name = this.opts.connection ?? this.Connection;
    const orm = (await container.resolve(Orm)) as Orm;
    const driver = orm.Connections.get(name);
    if (!driver) throw new AuthzConfigError(`DbScopeAttributeStore: ${CONNECTION_KEY} names connection ${JSON.stringify(name)}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    return driver;
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
