import { Class, ClassInfo } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { DateTime } from 'luxon';
import { OrmDriver } from './driver.js';
import { IMigrationDescriptor, OrmMigration } from './interfaces.js';
import { MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';
import { OrmException } from './exceptions.js';
import { DefaultMigrationService, IMigrationStatusEntry, IMigrationUnit, MigrationResolveAction, OrmMigrationService } from './migration-service.js';

/**
 * A migration class name carries its own creation timestamp - `SomeName_yyyy_MM_dd_HH_mm_ss` -
 * and that timestamp is the only ordering the runner has.
 */
export const MIGRATION_FILE_REGEXP = /(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/;

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
}

export interface IMigrationUpOptions {
  /**
   * Run even for connections whose `Migration.OnStartup` is off. Public callers ( CLI, an
   * explicit `orm.Migration.up()` ) default to true; only the boot path passes false.
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

  constructor(protected orm: IMigrationRunnerHost) {}

  /**
   * Applies every pending migration on every configured connection, or only `name` when one is
   * given, in `(created, name)` order.
   *
   * A `name` that matches nothing in the registry throws rather than returning `[]`: an empty
   * result from a typo is indistinguishable from "already up to date", so the CLI would exit 0
   * reporting "0 migrations applied" and the operator would believe the schema is current.
   */
  public async up(name?: string, options?: IMigrationUpOptions): Promise<OrmMigration[]> {
    const executed: OrmMigration[] = [];

    for (const [driver, units] of this.plan(name, options?.force ?? true, options?.connection)) {
      const service = await this.service(driver);
      executed.push(...(await service.up(units, { fake: options?.fake })));
    }

    return executed;
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
    const executed: OrmMigration[] = [];

    for (const [driver, units] of this.plan(name, options?.force ?? true, options?.connection)) {
      const service = await this.service(driver);
      executed.push(...(await service.down(units, { fake: options?.fake, all: options?.all })));
    }

    return executed;
  }

  public async status(): Promise<IMigrationStatusEntry[]> {
    const entries: IMigrationStatusEntry[] = [];

    // force: a status report that hid the connections with OnStartup off would answer "nothing
    // to see" for exactly the connections somebody is most likely asking about
    for (const [driver, units] of this.plan(undefined, true)) {
      const service = await this.service(driver);
      entries.push(...(await service.status(units)));
    }

    return entries;
  }

  /**
   * Forces a migration's recorded state on whichever connection owns it - the escape hatch for a
   * run that died halfway. The unit is handed down as well: the service cannot fingerprint a
   * migration it was only given the name of, and a resolution without it leaves `Checksum` NULL
   * forever, so drift is never detectable for that row again.
   */
  public async resolve(name: string, action: MigrationResolveAction): Promise<void> {
    for (const [driver, units] of this.plan(name, true)) {
      const unit = units.find((u) => u.name === name);

      if (unit) {
        return await (await this.service(driver)).resolve(name, action, unit);
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
   */
  protected plan(name: string | undefined, force: boolean, connection?: string): Array<[OrmDriver, IMigrationUnit[]]> {
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
      // timestamp first, then name: two migrations generated in the same second are otherwise
      // ordered by whatever the registry happened to hold, which differs between a file-scan
      // boot and a programmatic registration. Equal on both = 0, so the sort stays stable
      .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.name.localeCompare(b.name)));

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
      const md = (u.type as unknown as Record<symbol, IMigrationDescriptor | undefined>)[MIGRATION_DESCRIPTION_SYMBOL];

      // none of the three skips below throws: a connection missing from this deployment's
      // configuration, or switched off for startup, is a normal state - taking the whole boot
      // down over it would be worse than running what can be run
      if (!md?.Connection) {
        this.Log.warn(`Migration ${u.name} has no connection assigned ( missing @Migration('connection') decorator ) and is skipped`);
        continue;
      }

      const driver = this.orm.Connections.get(md.Connection);

      if (!driver) {
        this.Log.warn(`Connection ${md.Connection} not exists for migration ${u.name} - migration is skipped`);
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
          this.Log.warn(`Migration for connection ${md.Connection} is disabled on startup, please check conf file for db.[connection].Migration.OnStartup property`);
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
