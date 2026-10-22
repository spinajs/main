import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import type { ITransactionOptions, OrmDriver } from '@spinajs/orm';
import { Orm } from '@spinajs/orm';
import { AuthzAdminBackend, AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';
import type { AuthzTx, RememberedBatch } from '@spinajs/authz';

import { recordDriver, requireTransaction } from '../../stores/context.js';
import { VersionRecord, recordValues, toDateTime } from '../../stores/records.js';
import { AUTHZ_ADMIN_IDEMPOTENCY_TABLE, AUTHZ_VERSION_TABLE } from '../../stores/tables.js';
import { bumpVersion } from '../../stores/version.js';
import { AdminIdempotencyRecord } from './record.js';

const VERSION_MIGRATION = 'AuthzRbac_2026_10_01_00_00_00';
const IDEMPOTENCY_MIGRATION = 'AuthzAdminIdempotency_2026_10_02_00_01_00';
const DOMAIN_MAX = 64;
const ACTOR_MAX = 100;
const KEY_MAX = 160;
const DATE_TAG = '$authzDate';

interface EntryKey {
  readonly domain: string;
  readonly actor: string;
  readonly idem_key: string;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const length = (s: string): number => [...s].length;

/** Domains whose authz_version row is known to exist, per connection. */
const versionRows = new WeakMap<OrmDriver, Set<string>>();

function checkDomain(domain: string): void {
  if (typeof domain !== 'string' || domain === '' || length(domain) > DOMAIN_MAX) throw new AuthzConfigError(`DbAuthzAdminBackend: domain ${JSON.stringify(domain)} does not fit ${AUTHZ_VERSION_TABLE}.domain (${DOMAIN_MAX} characters)`);
}

/** The core only checks that the key is a non-empty string; the column widths are known here. */
function entryKey(domain: string, actorKey: string, key: string): EntryKey {
  checkDomain(domain);
  if (length(key) > KEY_MAX) throw new AuthzAdminFailure('invalid_batch', `idempotencyKey is longer than ${KEY_MAX} characters`, 'idempotencyKey');
  if (length(actorKey) > ACTOR_MAX) throw new AuthzAdminFailure('invalid_batch', `the actor ${JSON.stringify(actorKey.slice(0, 40))}... is longer than ${ACTOR_MAX} characters, so its batches cannot take an idempotencyKey`, 'idempotencyKey');
  return { domain, actor: actorKey, idem_key: key };
}

/** JSON that keeps Dates: each one becomes { $authzDate: iso } and comes back as a Date. */
function encode(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, k: string, v: unknown) {
    const raw = this[k];
    return raw instanceof Date ? { [DATE_TAG]: raw.toJSON() } : v;
  });
}

function decode(text: unknown, column: string): unknown {
  if (typeof text !== 'string') throw new AuthzConfigError(`DbAuthzAdminBackend: ${AUTHZ_ADMIN_IDEMPOTENCY_TABLE}.${column} holds ${String(text)}, not JSON text`);
  return JSON.parse(text, (_k, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const keys = Object.keys(v);
    if (keys.length !== 1 || keys[0] !== DATE_TAG) return v;
    const iso = (v as Record<string, unknown>)[DATE_TAG];
    return new Date(typeof iso === 'string' ? iso : NaN);
  });
}

/** Only a table that does not exist is blamed on its migration; a read of an existing table fails as it failed. */
async function readTable<T>(driver: OrmDriver, table: string, migration: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    let exists: boolean | undefined;
    try {
      exists = await driver.schema().tableExists(table);
    } catch {
      exists = undefined;
    }
    if (exists === true) throw e;
    const where = `${table} on connection ${JSON.stringify(driver.Options.Name)}`;
    const what = exists === false ? `table ${where} does not exist; migration ${migration} of @spinajs/authz-rbac creates it` : `cannot read ${where} (has migration ${migration} of @spinajs/authz-rbac run?)`;
    throw new AuthzConfigError(`DbAuthzAdminBackend: ${what}: ${describe(e)}`, { cause: e });
  }
}

/**
 * Nesting would turn the batch into a savepoint of the caller's transaction: AuthzAdmin would publish before the
 * data commits, the isolation level would be the caller's, and the domain lock would be held until the caller
 * commits.
 */
function refuseNested(driver: OrmDriver): void {
  if (driver.CurrentTransaction !== undefined) {
    throw new AuthzConfigError(`DbAuthzAdminBackend runs its own transaction; call AuthzAdmin outside db.transaction() on connection ${JSON.stringify(driver.Options.Name)}`);
  }
}

/** The domain lock: a no-op update of the domain's authz_version row, which still counts the row it matched. */
async function lockRow(domain: string): Promise<boolean> {
  const { RowsAffected } = await VersionRecord.update({ domain }).where('domain', domain);
  return RowsAffected > 0;
}

/**
 * AuthzAdmin batches in an ORM transaction on the connection db.Aliases.authz names, where the DB stores read
 * and write (AuthzTx.driver). Batches of one domain run one at a time: the first statement of every transaction
 * updates the domain's authz_version row, and that row lock is held until commit, so a batch plans on what the
 * one before it committed. Batches of different domains do not wait for each other. Selected with
 * `authz.admin.backend: 'DbAuthzAdminBackend'`; the default stays MemoryAuthzAdminBackend.
 */
@Singleton()
@Injectable(AuthzAdminBackend)
export class DbAuthzAdminBackend extends AuthzAdminBackend {
  /** Never read: injecting it resolves the Orm, which binds the models, before the first query. */
  @Autoinject(Orm)
  protected Orm: Orm;

  async transaction<T>(domain: string, fn: (tx: AuthzTx) => Promise<T>): Promise<T> {
    checkDomain(domain);
    const driver = recordDriver(VersionRecord);
    refuseNested(driver);
    // Under REPEATABLE READ or a stricter level, the batch's snapshot would hide what the batch before it committed.
    const options: ITransactionOptions | undefined = driver.SupportedIsolationLevels.includes('READ COMMITTED') ? { isolation: 'READ COMMITTED' } : undefined;
    await this.ensureVersionRow(driver, domain);
    return driver.transaction(async (d) => {
      await this.lock(d, domain);
      return fn(Object.freeze({ driver: d }));
    }, options);
  }

  async bumpVersion(domain: string, tx: AuthzTx): Promise<void> {
    checkDomain(domain);
    await bumpVersion(tx, domain, 'DbAuthzAdminBackend.bumpVersion');
  }

  async recall(domain: string, actorKey: string, key: string, now: Date): Promise<RememberedBatch | undefined> {
    const id = entryKey(domain, actorKey, key);
    const driver = recordDriver(AdminIdempotencyRecord);
    refuseNested(driver);
    await readTable(driver, AUTHZ_ADMIN_IDEMPOTENCY_TABLE, IDEMPOTENCY_MIGRATION, async () => {
      await AdminIdempotencyRecord.destroy().where('domain', domain).where('expires_at', '<=', now);
    });
    const [row] = await AdminIdempotencyRecord.query().where(id);
    if (!row || row.expires_at.toMillis() <= now.getTime()) return undefined;
    return { results: decode(row.results, 'results') as RememberedBatch['results'], rows: decode(row.rows, 'rows') as RememberedBatch['rows'] };
  }

  /** remember() has no clock: a row past its expiry by the wall clock is replaced. */
  async remember(domain: string, actorKey: string, key: string, batch: RememberedBatch, expiresAt: Date, tx: AuthzTx): Promise<'stored' | 'exists'> {
    const id = entryKey(domain, actorKey, key);
    const d = requireTransaction(AdminIdempotencyRecord, tx, 'DbAuthzAdminBackend.remember');
    const find = async () => (await AdminIdempotencyRecord.query().where(id))[0];
    const existing = await readTable(d, AUTHZ_ADMIN_IDEMPOTENCY_TABLE, IDEMPOTENCY_MIGRATION, find);
    if (existing) {
      if (existing.expires_at.toMillis() > Date.now()) return 'exists';
      await AdminIdempotencyRecord.destroy().where(id);
    }
    const row = { ...id, results: encode(batch.results), rows: encode(batch.rows), expires_at: toDateTime(expiresAt), created_at: toDateTime(new Date()) };
    try {
      // A savepoint: after a failed statement some databases refuse every other one of the transaction but a rollback.
      await d.transaction(async () => {
        await AdminIdempotencyRecord.insert(recordValues<AdminIdempotencyRecord>(row));
      });
    } catch (e) {
      if (await find()) return 'exists';
      throw e;
    }
    return 'stored';
  }

  /** Inserted outside the transaction, so the lock statement finds the row; another process may insert it first. */
  private async ensureVersionRow(driver: OrmDriver, domain: string): Promise<void> {
    const known = versionRows.get(driver) ?? new Set<string>();
    versionRows.set(driver, known);
    if (known.has(domain)) return;
    const exists = async () => (await VersionRecord.where('domain', domain)).length > 0;
    if (!(await readTable(driver, AUTHZ_VERSION_TABLE, VERSION_MIGRATION, exists))) {
      try {
        await VersionRecord.insert(recordValues<VersionRecord>({ domain, version: '0' }));
      } catch (e) {
        if (!(await exists())) throw e;
      }
    }
    known.add(domain);
  }

  /** The first statement of the transaction. A row deleted after it was cached is inserted, which locks the new row. */
  private async lock(d: OrmDriver, domain: string): Promise<void> {
    if (await lockRow(domain)) return;
    try {
      // A savepoint, so that a duplicate from a concurrent insert leaves the transaction usable.
      await d.transaction(async () => {
        await VersionRecord.insert(recordValues<VersionRecord>({ domain, version: '0' }));
      });
    } catch (e) {
      if (!(await lockRow(domain))) throw e;
    }
  }
}
