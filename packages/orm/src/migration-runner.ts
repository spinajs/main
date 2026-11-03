import { Class, ClassInfo } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import { AsyncLocalStorage } from 'node:async_hooks';
import { OrmDriver } from './driver.js';
import { OrmMigration } from './interfaces.js';
import { MIGRATION_FILE_REGEXP } from './symbols.js';
import { extractMigrationDescriptor, extractModelDescriptor } from './descriptor.js';
import { OrmException } from './exceptions.js';
import type { IMigrationLockHandle } from './migration-lock.js';
import { DefaultMigrationService, IMigrationRunOptions, IMigrationStatusEntry, IMigrationStatusOptions, IMigrationUnit, MigrationResolveAction, OrmMigrationService } from './migration-service.js';
import type { ModelBase } from './model.js';
import { recordSchemaTouches, SchemaTouches, touchAllTables } from './schema-touches.js';

/**
 * Re-exported from `./symbols.js` ( a leaf module ) rather than defined here, so this module can
 * sit in `Orm`'s require cycle without closing it one hop earlier. This is still the import path
 * the rest of the package - and `@spinajs/orm-cli` - use, and stays that way.
 */
export { MIGRATION_FILE_REGEXP } from './symbols.js';

/**
 * Timestamp first, then name: two migrations generated in the same second are otherwise ordered
 * by whatever the registry happened to hold, which differs between a file-scan boot and a
 * programmatic registration. Equal on both = 0, so a sort stays stable.
 */
function compareUnits(a: IMigrationUnit, b: IMigrationUnit): number {
  return compareMigrationNames(a.name, b.name);
}

function nameTimestamp(name: string): number | null {
  const match = name.match(MIGRATION_FILE_REGEXP);
  const created = match && match.length === 3 ? DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss') : null;

  return created?.isValid ? created.toMillis() : null;
}

/**
 * The order `migrate-up` applies migrations in, from their names alone: a free prefix does not take part.
 * A name without a parsable timestamp sorts after every parsable one, by name; `plan()` refuses such
 * names, so this only matters to a caller sorting names it did not take from a plan.
 */
export function compareMigrationNames(a: string, b: string): number {
  const ta = nameTimestamp(a);
  const tb = nameTimestamp(b);

  if (ta === null || tb === null) {
    return ta === tb ? a.localeCompare(b) : ta === null ? 1 : -1;
  }

  return ta - tb || a.localeCompare(b);
}

/** Code-unit order rather than `localeCompare`: two hosts with different locales must agree on it, or two runs can deadlock. */
function compareDriverNames(a: OrmDriver, b: OrmDriver): number {
  return a.Options.Name < b.Options.Name ? -1 : a.Options.Name > b.Options.Name ? 1 : 0;
}

/**
 * The slice of `Orm` this facade consumes. Narrow on purpose: the runner is constructible from
 * anything holding a migration registry and a connection map, which is what makes it testable
 * without booting an Orm.
 *
 * Named for its one consumer rather than for `Orm`: this is part of `@spinajs/orm`'s public
 * surface, and a name like `IOrmLike` would read as "the general-purpose Orm interface" to
 * everyone who imports it.
 */
export interface IMigrationRunnerHost {
  Migrations: Array<ClassInfo<OrmMigration>>;
  Connections: Map<string, OrmDriver>;
  /** The models `up()` can report as touched; without it the report names none. */
  Models?: Array<ClassInfo<ModelBase>>;
}

/** What a run changed, so that only those models get their table info read again. */
export interface IMigrationTouched {
  /**
   * Registered models whose table an applied migration created, altered, renamed or dropped. Every model of the
   * connection when one of its migrations ran raw SQL ( `schema().raw()`, `executeOnDb()` ) or a custom
   * `OrmMigrationService` applied it: neither names the tables it changes.
   */
  models: Array<Class<ModelBase>>;
}

export interface IMigrationUpResult {
  executed: OrmMigration[];
  touched: IMigrationTouched;
}

export interface IMigrationUpOptions {
  /**
   * Run even for connections whose `Migration.OnStartup` is off. Public callers ( CLI, an
   * explicit `OrmMigrator.migrate()` ) default to true; only the migrator's boot pass passes false.
   */
  force?: boolean;

  /**
   * Record the migrations as applied without running them.
   */
  fake?: boolean;

  /**
   * Limit the run to one connection, by name. Absent means every configured connection.
   *
   * The name is resolved to a driver before it is compared, so an alias ( `db.Aliases` ) and the
   * connection it points at select the same run. A name no connection answers to throws.
   */
  connection?: string;

  /** Set by a caller already holding `withRunLock()`; the run then takes no lock of its own. */
  locked?: boolean;
}

export interface IMigrationRunnerStatusOptions {
  /** Read without DDL: no tracking table is created or upgraded. */
  readOnly?: boolean;

  /** Report one connection, by name or alias. A name no connection answers to throws. */
  connection?: string;
}

/** One migration `up()` would apply, or a FAILED one that stops it, as `pending()` reports it. */
export interface IMigrationPlanEntry {
  name: string;
  connection: string;
  /** The batch the run would record it in: one past the connection's highest applied batch, a failed entry included. */
  batch: number;
  /** Recorded as FAILED: `up()` refuses its connection until `migrate-resolve` clears it, and the run stops there. */
  failed?: true;
}

export interface IMigrationDownFacadeOptions extends IMigrationUpOptions {
  /**
   * Roll every applied migration back instead of only the last batch.
   */
  all?: boolean;
}

/**
 * Cross-connection orchestrator: validates and orders the migration registry, groups it by the
 * connection each migration declared, and hands each group to that connection's
 * `OrmMigrationService`. Everything that touches a database lives in the service; everything
 * that spans connections lives here.
 */
export class MigrationRunner {
  @Logger('ORM')
  protected Log: Log;

  /** The run locks held by the enclosing `withRunLock()`, per driver. */
  protected RunLocks = new AsyncLocalStorage<Map<OrmDriver, IMigrationLockHandle>>();

  constructor(protected orm: IMigrationRunnerHost) {}

  /**
   * Holds one migration lock per connection that has registered migrations ( or only `connection`,
   * or only the one `name` runs on ) while `fn` runs, so several runner calls - `up()`, then the
   * seeds - form one run. Locks already held by an enclosing call are reused. An unknown `name`
   * throws before any lock is taken.
   */
  public async withRunLock<R>(connection: string | undefined, fn: () => Promise<R>, name?: string): Promise<R> {
    return await this.holdRunLocks(
      this.plan(name, true, connection, true).map(([driver]) => driver),
      fn,
    );
  }

  /** Rejects with `MigrationLockLostException` when a lock of the enclosing `withRunLock()` was lost. */
  public async assertRunLocksHeld(): Promise<void> {
    for (const lock of this.RunLocks.getStore()?.values() ?? []) {
      await lock.assertHeld();
    }
  }

  /**
   * Takes the locks in driver-name order, so two runs cannot deadlock each other, and releases them
   * in reverse. A service without `acquireRunLock()` is skipped: it locks inside its own calls.
   */
  protected async holdRunLocks<R>(drivers: OrmDriver[], fn: () => Promise<R>): Promise<R> {
    const held = new Map(this.RunLocks.getStore());
    const taken: Array<[OrmDriver, IMigrationLockHandle]> = [];

    try {
      for (const driver of [...new Set(drivers)].filter((d) => !held.has(d)).sort(compareDriverNames)) {
        const service = await this.service(driver);

        if (service.acquireRunLock && driver.Options.Migration?.Lock?.Enabled !== false) {
          const lock = await service.acquireRunLock();
          taken.push([driver, lock]);
          held.set(driver, lock);
        }
      }

      return await this.RunLocks.run(held, fn);
    } finally {
      for (const [driver, lock] of taken.reverse()) {
        await this.releaseQuietly(driver, lock);
      }
    }
  }

  /**
   * A failed release is logged, never thrown: a throw out of `finally` would replace the error the
   * run died with, and its likeliest cause is the same dead connection.
   */
  protected async releaseQuietly(driver: OrmDriver, lock: IMigrationLockHandle): Promise<void> {
    try {
      await lock.release();
    } catch (err) {
      this.Log.error(
        { error: err, connection: driver.Options.Name, holder: lock.holder },
        'Could not release the migration lock on connection ${connection} held as ${holder}. A lock-table row blocks further runs until it goes stale ( Migration.Lock.StaleAfter ) or is deleted by hand; a session lock ends with its session.',
      );
    }
  }

  /** What a service is told about the run lock held for `driver`, checked first; nothing when none is held. */
  protected async runLockOptions(driver: OrmDriver): Promise<Pick<IMigrationRunOptions, 'locked' | 'lock'>> {
    const lock = this.RunLocks.getStore()?.get(driver);

    if (!lock) {
      return {};
    }

    await lock.assertHeld();
    return { locked: true, lock };
  }

  protected async locking<R>(groups: Array<[OrmDriver, IMigrationUnit[]]>, options: IMigrationUpOptions | undefined, fn: () => Promise<R>): Promise<R> {
    return options?.locked ? await fn() : await this.holdRunLocks(groups.map(([driver]) => driver), fn);
  }

  /**
   * Applies every pending migration on every configured connection, or only `name` when one is
   * given, in `(created, name)` order ACROSS connections.
   *
   * Across, not connection by connection: migrations on different connections often target the
   * same server, and one of them may read what another created - a view in one schema over a
   * table a migration on another connection adds. Running each connection's whole backlog in
   * turn applies such a pair in the wrong order whenever both are pending at once, which is
   * exactly the case of a deployment catching up on several releases. So the pending set is
   * walked in global order and handed to each connection's service in consecutive stretches;
   * returning to a connection continues the batch it already opened.
   *
   * A `name` that matches nothing in the registry throws rather than returning `[]`: an empty
   * result from a typo is indistinguishable from "already up to date", so the CLI would exit 0
   * reporting "0 migrations applied" and the operator would believe the schema is current.
   *
   * The whole call holds one lock per connection ( `withRunLock()` ), taken before anything is read.
   */
  public async up(name?: string, options?: IMigrationUpOptions): Promise<IMigrationUpResult> {
    const groups = this.plan(name, options?.force ?? true, options?.connection);
    return await this.locking(groups, options, () => this.applyUp(groups, options));
  }

  protected async applyUp(groups: Array<[OrmDriver, IMigrationUnit[]]>, options?: IMigrationUpOptions): Promise<IMigrationUpResult> {
    const executed: OrmMigration[] = [];
    const opened = new Set<OrmDriver>();
    const touches: SchemaTouches = new Map();
    const drivers = new Set(this.orm.Connections.values());

    for (const [driver, units] of await this.stretches(groups)) {
      const service = await this.service(driver);
      const lock = await this.runLockOptions(driver);
      const ran = await recordSchemaTouches(touches, () => service.up(units, { fake: options?.fake, continueBatch: opened.has(driver), ...lock }), drivers);

      // only the built-in service runs up() where SQL sent straight to the driver is noticed
      if (ran.length > 0 && !options?.fake && !(service instanceof DefaultMigrationService)) {
        touchAllTables(touches, driver);
      }

      executed.push(...ran);
      opened.add(driver);
    }

    return { executed, touched: { models: this.touchedModels(touches) } };
  }

  /**
   * What `up(name, { connection })` would apply, in the order it would apply it, with the batch each one would get,
   * followed by the FAILED migrations ( `failed: true` ) of the connections it would run on. `up()` throws at the
   * first stretch of such a connection, so nothing from there on is listed as applied, on any connection.
   * Read-only: no tracking table is created, no lock is taken and no migration runs.
   */
  public async pending(name?: string, connection?: string): Promise<IMigrationPlanEntry[]> {
    const groups = this.plan(name, true, connection);
    const planned = new Set(groups.map(([driver]) => driver));
    const next = new Map<OrmDriver, number>();
    const failed: IMigrationPlanEntry[] = [];

    // every migration of the connection, not only `name`: the batch, and the failed rows that block `name`, follow from all of them
    for (const [driver, units] of this.plan(undefined, true, connection, true)) {
      const status = await (await this.service(driver)).status(units, { readOnly: true });
      const batch = Math.max(0, ...status.filter((e) => e.applied).map((e) => e.batch ?? 0)) + 1;
      next.set(driver, batch);

      if (planned.has(driver)) {
        failed.push(...status.filter((e) => e.failed).map((e): IMigrationPlanEntry => ({ name: e.name, connection: driver.Options.Name, batch, failed: true })));
      }
    }

    const blocked = new Set(failed.map((e) => e.connection));
    const entries: IMigrationPlanEntry[] = [];

    for (const [driver, units] of await this.stretches(groups, { readOnly: true })) {
      if (blocked.has(driver.Options.Name)) {
        break;
      }

      entries.push(...units.map((u) => ({ name: u.name, connection: driver.Options.Name, batch: next.get(driver) ?? 1 })));
    }

    return [...entries, ...failed.sort((a, b) => compareMigrationNames(a.name, b.name))];
  }

  protected touchedModels(touches: SchemaTouches): Array<Class<ModelBase>> {
    if (touches.size === 0) {
      return [];
    }

    return (this.orm.Models ?? [])
      .filter((m) => {
        const descriptor = extractModelDescriptor(m.type);
        const connection = descriptor?.Connection ? this.orm.Connections.get(descriptor.Connection)?.Options.Name : undefined;
        const touched = connection ? touches.get(connection) : undefined;

        return touched === 'all' || (touched !== undefined && !!descriptor?.TableName && touched.has(descriptor.TableName.toLowerCase()));
      })
      .map((m) => m.type as Class<ModelBase>);
  }

  /**
   * The planned groups re-cut into runs of consecutive same-connection migrations, in global
   * `(created, name)` order.
   *
   * Only what still has to run takes part in the cut - applied migrations would split the
   * pending ones into many needless stretches, each one lock and one table read. A FAILED
   * migration does take part: its service refuses the run at that point, as it always has.
   *
   * A connection with nothing left to run still gets an empty stretch, at the end: the service's
   * refusal to run over a FAILED row covers every row of the connection, registered or not, and
   * skipping the call would quietly drop that guard for it.
   */
  protected async stretches(groups: Array<[OrmDriver, IMigrationUnit[]]>, statusOptions?: IMigrationStatusOptions): Promise<Array<[OrmDriver, IMigrationUnit[]]>> {
    const queue: Array<{ driver: OrmDriver; unit: IMigrationUnit }> = [];
    const idle: OrmDriver[] = [];

    for (const [driver, units] of groups) {
      const status = await (await this.service(driver)).status(units, statusOptions);
      const open = new Set(status.filter((s) => s.pending || s.failed).map((s) => s.name));

      if (open.size === 0) {
        idle.push(driver);
      }

      queue.push(...units.filter((u) => open.has(u.name)).map((unit) => ({ driver, unit })));
    }

    queue.sort((a, b) => compareUnits(a.unit, b.unit));

    const result: Array<[OrmDriver, IMigrationUnit[]]> = [];

    for (const { driver, unit } of queue) {
      const last = result[result.length - 1];

      if (last && last[0] === driver) {
        last[1].push(unit);
      } else {
        result.push([driver, [unit]]);
      }
    }

    return [...result, ...idle.map((driver): [OrmDriver, IMigrationUnit[]] => [driver, []])];
  }

  /**
   * Rolls the last applied batch back on every configured connection, or every batch with
   * `{ all: true }`. `name` narrows the run to a single migration and - exactly like `up` - throws
   * when the registry carries nothing by that name.
   *
   * KNOWN SHARP EDGE, `down(name)`: the service is handed a one-element unit list, and it treats
   * every applied row in the target batch that has no matching unit as an orphan. So a named
   * rollback warns that perfectly healthy, merely-unrequested migrations are "recorded as applied
   * but no registered migration matches them (file deleted or renamed)" and advises restoring the
   * file or removing the row by hand - guidance that is destructive if followed here, because
   * nothing is actually wrong with those rows. The rollback itself is correct; only the warning
   * lies. Fixing it means giving `IMigrationDownOptions` an "only these" notion, i.e. reshaping the
   * service contract, so it is deliberately not done inside this facade.
   */
  public async down(name?: string, options?: IMigrationDownFacadeOptions): Promise<OrmMigration[]> {
    const groups = this.plan(name, options?.force ?? true, options?.connection);

    return await this.locking(groups, options, async () => {
      const executed: OrmMigration[] = [];

      for (const [driver, units] of groups) {
        const service = await this.service(driver);
        executed.push(...(await service.down(units, { fake: options?.fake, all: options?.all, ...(await this.runLockOptions(driver)) })));
      }

      return executed;
    });
  }

  public async status(options: IMigrationRunnerStatusOptions = {}): Promise<IMigrationStatusEntry[]> {
    const entries: IMigrationStatusEntry[] = [];

    // force: a status report that hid the connections with OnStartup off would answer "nothing
    // to see" for exactly the connections somebody is most likely asking about
    for (const [driver, units] of this.plan(undefined, true, options.connection)) {
      const service = await this.service(driver);
      entries.push(...(await service.status(units, { readOnly: options.readOnly })));
    }

    return entries;
  }

  /**
   * Forces a migration's recorded state on whichever connection owns it - the escape hatch for a
   * run that died halfway. The unit is handed down as well: the service cannot fingerprint a
   * migration it was only given the name of, and a resolution without it leaves `Checksum` NULL
   * forever, so drift is never detectable for that row again.
   *
   * It holds the connection's run lock, so it cannot rewrite a row under a run in progress.
   */
  public async resolve(name: string, action: MigrationResolveAction): Promise<void> {
    for (const [driver, units] of this.plan(name, true)) {
      const unit = units.find((u) => u.name === name);

      if (unit) {
        return await this.holdRunLocks([driver], async () => await (await this.service(driver)).resolve(name, action, unit));
      }
    }

    // `plan()` already refused an unknown name, so reaching here means the class IS registered and
    // `plan()` dropped it: the connection it declared is missing from this deployment's
    // configuration, or it carries no `@Migration()` at all. Both left a warn naming it. Silently
    // doing nothing would look like a successful resolve and leave the connection blocked
    throw new OrmException(`Migration ${name} is registered, but its connection is not configured ( or the class carries no @Migration('connection') decorator ) - nothing to resolve`);
  }

  /**
   * The connection's configured `OrmMigrationService`, or the built-in one.
   */
  protected async service(driver: OrmDriver): Promise<OrmMigrationService> {
    const token = driver.Options.Migration?.Service;

    return await driver.Container.resolve<OrmMigrationService>((token ?? DefaultMigrationService) as Class<OrmMigrationService>, [driver]);
  }

  /**
   * Validates every registered migration's name, orders the set, and groups it by the connection
   * it declared - returning one ordered unit list per connection that is actually going to run.
   *
   * Keyed by driver rather than by connection name so aliases ( two names bound to the same
   * `OrmDriver` ) collapse into one group instead of running the same migration twice.
   *
   * `name` narrows the set to one migration, and is the single place all three public entry
   * points get their "that name is not registered" refusal from. `connection` narrows it to one
   * connection - the two compose, and a `name` on a connection the filter excludes runs nothing.
   *
   * `quiet` drops the skip warnings, for a caller that plans the same run a second time.
   */
  protected plan(name: string | undefined, force: boolean, connection?: string, quiet = false): Array<[OrmDriver, IMigrationUnit[]]> {
    const log = quiet ? undefined : this.Log;

    // `ClassInfo.name` is the migration's identity everywhere else in the system - it is what the
    // filter below matches, what becomes `IMigrationUnit.name`, and what lands in the `Migration`
    // column the service compares its rows against. So `m.name` ( never `m.type.name`, which
    // `Orm.registerMigration` copies it from and which is therefore only *usually* the same ) is
    // what gets validated, reported and recorded here - one value, so the three cannot disagree.
    const source = name ? this.orm.Migrations.filter((m) => m.name === name) : this.orm.Migrations;

    // an explicitly named migration that matches nothing is a typo, not an empty run. Returning
    // [] would let `migrate-up --name Ceate_2021_01_01_00_00_00` exit 0 reporting "0 migrations
    // applied", leaving the operator believing the schema is current - the same reason `resolve()`
    // refuses to no-op below
    if (name && source.length === 0) {
      throw new OrmException(`Migration ${name} is not registered - check the name for typos`);
    }

    const units = source
      .map((m) => {
        const match = m.name.match(MIGRATION_FILE_REGEXP);
        const created = match && match.length === 3 ? DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss') : null;

        // a migration whose name carries no timestamp cannot be placed in the order, and a
        // half-ordered run applies schema changes in an order nobody described - so the whole
        // set is refused rather than the one entry skipped
        if (!created || !created.isValid) {
          throw new OrmException(`Migration ${m.name} has invalid name format - expected some_name_yyyy_MM_dd_HH_mm_ss`);
        }

        return { name: m.name, created, type: m.type } as IMigrationUnit;
      })
      .sort(compareUnits);

    // Resolved to a DRIVER rather than compared as a string, because that is what the groups
    // below are keyed by: `db.Aliases` binds several names to one `OrmDriver`, so
    // `--connection <alias>` and `--connection <the name it points at>` have to select the same
    // group. Comparing the migration's declared `@Migration('...')` name instead would make those
    // two filters disagree about a connection that is one connection.
    let only: OrmDriver | undefined;

    if (connection !== undefined) {
      only = this.orm.Connections.get(connection);

      // refused for the same reason an unregistered migration name is: a filter that matches
      // nothing would let `migrate-up --connection typo` exit 0 reporting "0 migrations applied",
      // and the operator would believe the schema is current
      if (!only) {
        throw new OrmException(`Connection ${connection} is not configured - check the name for typos ( configured: ${[...this.orm.Connections.keys()].join(', ') || 'none'} )`);
      }
    }

    const groups = new Map<OrmDriver, IMigrationUnit[]>();
    const gated = new Set<OrmDriver>();

    for (const u of units) {
      // chain-walking, deliberately: a subclass is still the same migration on the same
      // connection whether or not it re-declares @Migration() - unlike Env ( own-only, see
      // Orm.discoverMigrations() ), Connection is meant to be inherited.
      const md = extractMigrationDescriptor(u.type);

      // none of the three skips below throws: a connection missing from this deployment's
      // configuration, or switched off for startup, is a normal state - taking the whole boot
      // down over it would be worse than running what can be run
      if (!md?.Connection) {
        log?.warn({ migration: u.name }, "Migration ${migration} has no connection assigned ( missing @Migration('connection') decorator ) and is skipped");
        continue;
      }

      const driver = this.orm.Connections.get(md.Connection);

      if (!driver) {
        log?.warn({ connection: md.Connection, migration: u.name }, 'Connection ${connection} not exists for migration ${migration} - migration is skipped');
        continue;
      }

      // silently, and before the OnStartup gate below: the operator asked for one connection, so
      // a line per migration on every OTHER connection is noise, and the gate warning in
      // particular would name connections this run was never going to touch
      if (only && driver !== only) {
        continue;
      }

      if (!driver.Options.Migration?.OnStartup && !force) {
        // the gate belongs to the connection, not to the migration, so it is reported once -
        // repeating it per migration turns a boot log into noise nobody reads
        if (!gated.has(driver)) {
          gated.add(driver);
          log?.warn({ connection: md.Connection }, 'Migration for connection ${connection} is disabled on startup, please check conf file for db.[connection].Migration.OnStartup property');
        }

        continue;
      }

      const group = groups.get(driver);

      if (group) {
        group.push(u);
      } else {
        groups.set(driver, [u]);
      }
    }

    return [...groups.entries()];
  }
}
