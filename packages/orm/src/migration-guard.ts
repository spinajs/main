import { Configuration } from '@spinajs/configuration';
import { Autoinject, NewInstance } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { OrmDriver } from './driver.js';
import { IPendingMigration, pendingMigrationsMessage, PendingMigrationsException } from './exceptions.js';
import { IMigrationRunnerHost, MigrationRunner } from './migration-runner.js';
import { IMigrationRecord, IMigrationUnit, MIGRATION_TABLE_NAME } from './migration-service.js';
import { MIGRATION_FILE_REGEXP } from './symbols.js';

export type MigrationCheckMode = 'fail' | 'warn' | 'off';

export interface IOrmMigrationGuardOptions {
  /** `false` in a process that operates on migrations ( `resolveMigrationTool()` ): no check, and the Orm skips db.StrictTableCheck. */
  Enabled?: boolean;
}

export interface IMigrationGuardReport {
  pending: IPendingMigration[];
  failed: IPendingMigration[];
  /** Connections whose problems were only logged, because their mode is `warn`. */
  warned: string[];
}

type Findings = Pick<IMigrationGuardReport, 'pending' | 'failed'>;

/** Run order inside a connection: the timestamp the name carries, then the name. */
function runOrder(a: string, b: string): number {
  const stamp = (n: string) => n.match(MIGRATION_FILE_REGEXP)?.[2] ?? '';

  return stamp(a).localeCompare(stamp(b)) || a.localeCompare(b);
}

function sortPending(items: IPendingMigration[]): IPendingMigration[] {
  return [...items].sort((a, b) => a.connection.localeCompare(b.connection) || runOrder(a.name, b.name));
}

/** Reuses the runner's grouping: aliases collapse into one driver, names are validated, other environments are already filtered out. */
class GuardPlan extends MigrationRunner {
  public groups(): Array<[OrmDriver, IMigrationUnit[]]> {
    return this.plan(undefined, true);
  }
}

/**
 * Boot check: refuses to start on a database with pending or failed migrations. Reads each
 * connection's tracking table and never creates or changes anything.
 */
@NewInstance()
export class OrmMigrationGuard {
  @Logger('ORM')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  constructor(protected Options: IOrmMigrationGuardOptions = {}) {}

  public get Enabled(): boolean {
    return this.Options.Enabled !== false;
  }

  public async check(orm: IMigrationRunnerHost): Promise<IMigrationGuardReport> {
    this.warnDeprecatedOnStartup(orm);

    const failing: Findings = { pending: [], failed: [] };
    const warning: Findings = { pending: [], failed: [] };

    for (const [driver, units] of new GuardPlan(orm).groups()) {
      const mode = this.mode(driver);

      if (mode === 'off') {
        continue;
      }

      const target = mode === 'warn' ? warning : failing;
      const found = await this.read(
        driver,
        units.map((u) => u.name),
      );

      target.pending.push(...found.pending);
      target.failed.push(...found.failed);
    }

    this.logWarned(warning);

    if (failing.pending.length > 0 || failing.failed.length > 0) {
      throw new PendingMigrationsException(sortPending(failing.pending), sortPending(failing.failed));
    }

    return {
      pending: sortPending(warning.pending),
      failed: sortPending(warning.failed),
      warned: [...new Set([...warning.pending, ...warning.failed].map((m) => m.connection))].sort(),
    };
  }

  protected mode(driver: OrmDriver): MigrationCheckMode {
    return driver.Options.Migration?.Check ?? this.Configuration.get<MigrationCheckMode>('db.MigrationCheck', 'fail');
  }

  /**
   * Rows that match no registered migration are ignored: after a rolling deploy the database may be
   * ahead of this release. A column absent from a row ( a table older than the upgrade ) counts as
   * set, as `backfillLegacyRows()` treats it.
   */
  protected async read(driver: OrmDriver, names: string[]): Promise<Findings> {
    const table = driver.Options.Migration?.Table ?? MIGRATION_TABLE_NAME;
    const rows = (await driver.schema().tableExists(table)) ? (((await driver.select().from(table)) ?? []) as IMigrationRecord[]) : [];
    const connection = driver.Options.Name;
    const result: Findings = { pending: [], failed: [] };

    for (const name of names) {
      const row = rows.find((r) => r.Migration === name);
      const finished = row !== undefined && (row.FinishedAt === undefined || !!row.FinishedAt);

      if (finished && !row.RolledBackAt) {
        continue;
      }

      (row && !finished && row.Logs ? result.failed : result.pending).push({ name, connection });
    }

    return result;
  }

  protected logWarned(report: Findings): void {
    for (const connection of new Set([...report.pending, ...report.failed].map((m) => m.connection))) {
      const text = pendingMigrationsMessage(
        report.pending.filter((m) => m.connection === connection),
        report.failed.filter((m) => m.connection === connection),
      );

      this.Log.warn({ connection }, text);
    }
  }

  protected warnDeprecatedOnStartup(orm: IMigrationRunnerHost): void {
    for (const [name, driver] of orm.Connections) {
      if (driver.Options.Name === name && driver.Options.Migration?.OnStartup !== undefined) {
        this.Log.warn(`db.Connections[${name}].Migration.OnStartup is ignored: the application never migrates. Run "npx spinajs migrate-up" as a deploy step and remove the key.`);
      }
    }
  }
}
