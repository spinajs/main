import { DI, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { Orm, OrmDriver } from '@spinajs/orm';
import type { ITransactionOptions } from '@spinajs/orm';
import { AuthzAdminBackend, AuthzAdminFailure, AuthzConfigError } from '@spinajs/authz';
import type { AuthzTx, RememberedBatch } from '@spinajs/authz';

const VERSION_TABLE = 'authz_version';
const VERSION_MIGRATION = 'AuthzRbac_2026_10_01_00_00_00';
const TABLE = 'authz_admin_idempotency';
const CONNECTION_KEY = 'authz.admin.connection';
const DOMAIN_MAX = 64;
const ACTOR_MAX = 100;
const KEY_MAX = 160;
const DATE_TAG = '$authzDate';

export interface DbAuthzAdminBackendOptions {
  /** The ORM connection; default: config authz.admin.connection, else the ORM default connection. */
  readonly connection?: string;
  /** Where Configuration and Orm are resolved; default the DI root. */
  readonly container?: IContainer;
}

interface EntryKey {
  readonly domain: string;
  readonly actor: string;
  readonly idem_key: string;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const length = (s: string): number => [...s].length;

/**
 * One queue per connection, shared by every backend instance: SQLite runs every statement on one handle, so a
 * second transaction opened while one is running would nest inside it. Batches are short and rare, so pooled
 * drivers queue too, which also keeps a waiting batch from holding a pool connection.
 */
const queues = new WeakMap<OrmDriver, Promise<unknown>>();

function serial<T>(driver: OrmDriver, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(driver) ?? Promise.resolve()).then(fn);
  queues.set(
    driver,
    run.catch(() => undefined),
  );
  return run;
}

/** Domains whose authz_version row is known to exist, per connection. */
const versionRows = new WeakMap<OrmDriver, Set<string>>();

function checkDomain(domain: string): void {
  if (typeof domain !== 'string' || domain === '' || length(domain) > DOMAIN_MAX) throw new AuthzConfigError(`DbAuthzAdminBackend: domain ${JSON.stringify(domain)} does not fit ${VERSION_TABLE}.domain (${DOMAIN_MAX} characters)`);
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
  if (typeof text !== 'string') throw new AuthzConfigError(`DbAuthzAdminBackend: ${TABLE}.${column} holds ${String(text)}, not JSON text`);
  return JSON.parse(text, (_k, v: unknown) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const keys = Object.keys(v);
    if (keys.length !== 1 || keys[0] !== DATE_TAG) return v;
    const iso = (v as Record<string, unknown>)[DATE_TAG];
    return new Date(typeof iso === 'string' ? iso : NaN);
  });
}

const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(v as string));

/**
 * AuthzAdmin batches in an ORM transaction on the connection authz.admin.connection names: the DB stores read
 * and write through that transaction's driver (AuthzTx.driver). Batches of one domain run one at a time: the
 * first statement of every transaction updates the domain's authz_version row, and that row lock is held until
 * commit, so a batch plans on what the one before it committed. Selected with
 * `authz.admin.backend: 'DbAuthzAdminBackend'`; the default stays MemoryAuthzAdminBackend.
 */
@Singleton()
@Injectable(AuthzAdminBackend)
export class DbAuthzAdminBackend extends AuthzAdminBackend {
  constructor(private readonly opts: DbAuthzAdminBackendOptions = {}) {
    super();
  }

  async transaction<T>(domain: string, fn: (tx: AuthzTx) => Promise<T>): Promise<T> {
    checkDomain(domain);
    const driver = await this.connection();
    // MySQL defaults to REPEATABLE READ, whose snapshot would hide what the batch before this one committed.
    const options: ITransactionOptions | undefined = driver.SupportedIsolationLevels.includes('READ COMMITTED') ? { isolation: 'READ COMMITTED' } : undefined;
    return serial(driver, async () => {
      await this.ensureVersionRow(driver, domain);
      return driver.transaction(async (d) => {
        await d.update().in(VERSION_TABLE).update({ domain }).where({ domain });
        return fn(Object.freeze({ driver: d }));
      }, options);
    });
  }

  async bumpVersion(domain: string, tx: AuthzTx): Promise<void> {
    checkDomain(domain);
    const d = await this.inTransaction(tx);
    const rows = ((await d.select().from(VERSION_TABLE).columns(['version']).where({ domain })) ?? []) as { version: number | string }[];
    if (rows.length === 0) await d.insert().into(VERSION_TABLE).values({ domain, version: 1 });
    else
      await d
        .update()
        .in(VERSION_TABLE)
        .update({ version: Number(rows[0].version) + 1 })
        .where({ domain });
  }

  async recall(domain: string, actorKey: string, key: string, now: Date): Promise<RememberedBatch | undefined> {
    const id = entryKey(domain, actorKey, key);
    const driver = await this.connection();
    return serial(driver, async () => {
      await driver.del().from(TABLE).where('expires_at', '<=', now);
      const [row] = ((await driver.select().from(TABLE).columns(['results', 'rows', 'expires_at']).where(id)) ?? []) as Record<string, unknown>[];
      if (!row || toDate(row.expires_at).getTime() <= now.getTime()) return undefined;
      return { results: decode(row.results, 'results') as RememberedBatch['results'], rows: decode(row.rows, 'rows') as RememberedBatch['rows'] };
    });
  }

  /** remember() has no clock: a row past its expiry by the wall clock is replaced. */
  async remember(domain: string, actorKey: string, key: string, batch: RememberedBatch, expiresAt: Date, tx: AuthzTx): Promise<'stored' | 'exists'> {
    const id = entryKey(domain, actorKey, key);
    const d = await this.inTransaction(tx);
    const find = async () => (((await d.select().from(TABLE).columns(['expires_at']).where(id)) ?? []) as { expires_at: unknown }[])[0];
    const existing = await find();
    if (existing) {
      if (toDate(existing.expires_at).getTime() > Date.now()) return 'exists';
      await d.del().from(TABLE).where(id);
    }
    const row = { ...id, results: encode(batch.results), rows: encode(batch.rows), expires_at: expiresAt, created_at: new Date() };
    try {
      // A savepoint: after a failed insert PostgreSQL refuses every statement of the transaction but a rollback.
      await d.transaction(async () => {
        await d.insert().into(TABLE).values(row);
      });
    } catch (e) {
      if (await find()) return 'exists';
      throw e;
    }
    return 'stored';
  }

  /** Inserted outside the transaction, so the lock statement always finds the row; another process may insert it first. */
  private async ensureVersionRow(driver: OrmDriver, domain: string): Promise<void> {
    const known = versionRows.get(driver) ?? new Set<string>();
    versionRows.set(driver, known);
    if (known.has(domain)) return;
    const exists = async () => (((await driver.select().from(VERSION_TABLE).columns(['domain']).where({ domain })) ?? []) as unknown[]).length > 0;
    let found: boolean;
    try {
      found = await exists();
    } catch (e) {
      throw new AuthzConfigError(`DbAuthzAdminBackend: cannot read ${VERSION_TABLE} on connection ${JSON.stringify(driver.Options.Name)}; migration ${VERSION_MIGRATION} of @spinajs/authz-rbac creates it (${describe(e)})`, { cause: e });
    }
    if (!found) {
      try {
        await driver.insert().into(VERSION_TABLE).values({ domain, version: 0 });
      } catch (e) {
        if (!(await exists())) throw e;
      }
    }
    known.add(domain);
  }

  private async inTransaction(tx: AuthzTx): Promise<OrmDriver> {
    const driver = (tx as AuthzTx | undefined)?.driver;
    if (!(driver instanceof OrmDriver) || driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError('DbAuthzAdminBackend: bumpVersion and remember run only inside its transaction: AuthzTx.driver must be the OrmDriver of the running transaction');
    }
    if (driver !== (await this.connection())) throw new AuthzConfigError(`DbAuthzAdminBackend: the transaction runs on another connection than the one ${CONNECTION_KEY} names`);
    return driver;
  }

  private async connection(): Promise<OrmDriver> {
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
    if (!driver) throw new AuthzConfigError(`DbAuthzAdminBackend: ${CONNECTION_KEY} names connection ${JSON.stringify(name)}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    return driver;
  }
}
