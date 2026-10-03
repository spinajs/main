import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, OrmDriver } from '@spinajs/orm';
import { AuthzConfigError, SCOPE_ATTRIBUTE_LIMITS, WritableScopeAttributeStore, parseAttributeLeaf, principalKey, underPath, unflattenAttributes } from '@spinajs/authz';
import type { AuthzTx, PrincipalRef, ResourceRef, ScopeAttributeLeaf } from '@spinajs/authz';

const TABLE = 'authz_scope_attribute';
const CONNECTION_KEY = 'authz.admin.connection';
// value_text varchar(255); value_num decimal(20,6) holds 14 digits before the point.
const TEXT_MAX = 255;
const NUM_MAX = 1e14;
const KEY_MAX = 64;
const BY_MAX = 100;

/**
 * version() reads this row: every write replaces its value with a fresh id inside the write's
 * transaction, so a rollback keeps the old version and no two writes share one.
 */
const VERSION = Object.freeze({ scope_type: '$version', scope_id: '', path: 'version' });

interface Row {
  readonly path: string;
  readonly value_json: string;
}

export interface DbScopeAttributeStoreOptions {
  /** The ORM connection reads use; default: config authz.admin.connection, else the ORM default connection. */
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
  constructor(private readonly opts: DbScopeAttributeStoreOptions = {}) {
    super();
  }

  async get(ref: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    return unflattenAttributes(await this.rows(ref));
  }

  async version(): Promise<string> {
    const rows = (await (
      await this.reader()
    )
      .select()
      .from(TABLE)
      .columns(['value_json'])
      .where({ ...VERSION })) as Row[];
    return rows[0] ? String(parseAttributeLeaf(rows[0].value_json, `${TABLE} version row`)) : '0';
  }

  async rows(ref: ResourceRef): Promise<Readonly<Record<string, ScopeAttributeLeaf>>> {
    const out: Record<string, ScopeAttributeLeaf> = {};
    for (const r of await this.select(await this.reader(), ref)) out[r.path] = parseAttributeLeaf(r.value_json, `${TABLE} row ${JSON.stringify(r.path)}`);
    return out;
  }

  async write(ref: ResourceRef, change: { readonly set: Readonly<Record<string, ScopeAttributeLeaf>>; readonly remove: readonly string[] }, actor: PrincipalRef, tx: AuthzTx): Promise<number> {
    const driver = this.writer(tx);
    const key = keyOf(ref);
    const set = Object.entries(change?.set ?? {});
    const remove = [...(change?.remove ?? [])];
    for (const [path, v] of set) {
      if (path === '' || path.length > SCOPE_ATTRIBUTE_LIMITS.path) throw new AuthzConfigError(`DbScopeAttributeStore: path ${JSON.stringify(path)} does not fit ${TABLE}.path`);
      if (!isLeaf(v)) throw new AuthzConfigError(`DbScopeAttributeStore: ${JSON.stringify(path)} holds ${String(v)}, not a scalar`);
      if (JSON.stringify(v).length > SCOPE_ATTRIBUTE_LIMITS.json) throw new AuthzConfigError(`DbScopeAttributeStore: the value at ${JSON.stringify(path)} does not fit ${TABLE}.value_json`);
    }
    if (!remove.every((p) => typeof p === 'string' && p !== '')) throw new AuthzConfigError('DbScopeAttributeStore: remove must list paths');

    const existing = (await this.select(driver, ref)).map((r) => r.path);
    const removed = existing.filter((p) => remove.some((r) => underPath(p, r)));
    const replaced = set.map(([p]) => p).filter((p) => existing.includes(p));
    const doomed = [...new Set([...removed, ...replaced])];
    if (doomed.length > 0) await driver.del().from(TABLE).where(key).whereIn('path', doomed);
    if (set.length > 0) {
      const now = new Date();
      const by = principalKey(actor).slice(0, BY_MAX);
      await driver
        .insert()
        .into(TABLE)
        .values(set.map(([path, v]) => ({ ...key, path, value_json: JSON.stringify(v), value_text: typeof v === 'string' && v.length <= TEXT_MAX ? v : null, value_num: typeof v === 'number' && Math.abs(v) < NUM_MAX ? v : null, updated_by: by, updated_at: now })));
    }
    await this.bump(driver);
    return removed.length + set.length;
  }

  async forget(ref: ResourceRef, tx: AuthzTx): Promise<number> {
    const driver = this.writer(tx);
    const key = keyOf(ref);
    const count = (await this.select(driver, ref)).length;
    if (count > 0) await driver.del().from(TABLE).where(key);
    await this.bump(driver);
    return count;
  }

  private async select(driver: OrmDriver, ref: ResourceRef): Promise<Row[]> {
    return ((await driver.select().from(TABLE).columns(['path', 'value_json']).where(keyOf(ref))) ?? []) as Row[];
  }

  private async bump(driver: OrmDriver): Promise<void> {
    await driver
      .del()
      .from(TABLE)
      .where({ ...VERSION });
    const id = randomUUID();
    await driver
      .insert()
      .into(TABLE)
      .values({ ...VERSION, value_json: JSON.stringify(id), value_text: id, value_num: null, updated_by: null, updated_at: new Date() });
  }

  private writer(tx: AuthzTx): OrmDriver {
    const driver = (tx as AuthzTx | undefined)?.driver;
    if (!(driver instanceof OrmDriver) || driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError('DbScopeAttributeStore writes only inside an ORM transaction: AuthzTx.driver must be the OrmDriver of the running transaction (authz.admin.backend must be a DB backend)');
    }
    return driver;
  }

  private async reader(): Promise<OrmDriver> {
    const container = this.opts.container ?? DI.RootContainer;
    let name = this.opts.connection;
    if (name === undefined) {
      const configuration = (await container.resolve(Configuration)) as Configuration;
      const configured = configuration.get<unknown>(['authz', 'admin', 'connection']);
      if (configured !== undefined && (typeof configured !== 'string' || configured === '')) throw new AuthzConfigError(`configuration key ${CONNECTION_KEY} must be a connection name, got ${JSON.stringify(configured)}`);
      name = (configured as string | undefined) ?? 'default';
    }
    const orm = (await container.resolve(Orm)) as Orm;
    const driver = orm.Connections.get(name);
    if (!driver) throw new AuthzConfigError(`DbScopeAttributeStore: ${CONNECTION_KEY} names connection ${JSON.stringify(name)}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    return driver;
  }
}

function keyOf(ref: ResourceRef): { scope_type: string; scope_id: string } {
  if (ref === null || typeof ref !== 'object' || typeof ref.type !== 'string' || ref.type === '' || (ref.id != null && typeof ref.id !== 'string')) throw new AuthzConfigError(`DbScopeAttributeStore needs a resource ref, got ${JSON.stringify(ref)}`);
  if (ref.type === VERSION.scope_type) throw new AuthzConfigError(`DbScopeAttributeStore: type ${VERSION.scope_type} is reserved for its version row`);
  const id = ref.id ?? '';
  if (ref.type.length > KEY_MAX || id.length > KEY_MAX) throw new AuthzConfigError(`DbScopeAttributeStore: ${JSON.stringify(ref)} does not fit ${TABLE}.scope_type/scope_id (${KEY_MAX} characters each)`);
  return { scope_type: ref.type, scope_id: id };
}
