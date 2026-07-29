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
 */
export interface IOrmLike {
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

  constructor(protected orm: IOrmLike) {}

  public async up(name?: string, options?: IMigrationUpOptions): Promise<OrmMigration[]> {
    const executed: OrmMigration[] = [];

    for (const [driver, units] of this.plan(name, options?.force ?? true)) {
      const service = await this.service(driver);
      executed.push(...(await service.up(units, { fake: options?.fake })));
    }

    return executed;
  }

  public async down(name?: string, options?: IMigrationDownFacadeOptions): Promise<OrmMigration[]> {
    const executed: OrmMigration[] = [];

    for (const [driver, units] of this.plan(name, options?.force ?? true)) {
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

    // no connection claims it: either the name is a typo or its class is gone. Silently doing
    // nothing would look like a successful resolve and leave the connection blocked
    throw new OrmException(`Migration ${name} is not registered - nothing to resolve`);
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
   */
  protected plan(name: string | undefined, force: boolean): Array<[OrmDriver, IMigrationUnit[]]> {
    const source = name ? this.orm.Migrations.filter((m) => m.name === name) : this.orm.Migrations;

    const units = source
      .map((m) => {
        const match = m.type.name.match(MIGRATION_FILE_REGEXP);
        const created = match && match.length === 3 ? DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss') : null;

        // a migration whose name carries no timestamp cannot be placed in the order, and a
        // half-ordered run applies schema changes in an order nobody described - so the whole
        // set is refused rather than the one entry skipped
        if (!created || !created.isValid) {
          throw new OrmException(`Migration file ${m.name} have invalid name format ( invalid migration name,  expected: some_name_yyyy_MM_dd_HH_mm_ss got ${m.name})`);
        }

        return { name: m.name, created, type: m.type } as IMigrationUnit;
      })
      // timestamp first, then name: two migrations generated in the same second are otherwise
      // ordered by whatever the registry happened to hold, which differs between a file-scan
      // boot and a programmatic registration. Equal on both = 0, so the sort stays stable
      .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.name.localeCompare(b.name)));

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
