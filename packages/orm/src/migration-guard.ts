import { Configuration } from '@spinajs/configuration';
import { Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import { OrmDriver } from './driver.js';
import { IPendingMigration, OrmException, pendingMigrationsMessage, PendingMigrationsException } from './exceptions.js';
import { compareMigrationNames, IMigrationRunnerHost, MigrationRunner } from './migration-runner.js';
import { IMigrationUnit } from './migration-service.js';

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

function sortPending(items: IPendingMigration[]): IPendingMigration[] {
  return [...items].sort((a, b) => a.connection.localeCompare(b.connection) || compareMigrationNames(a.name, b.name));
}

/** Drops the connections the predicate rejects before their service is asked, so an `off` connection is never queried. */
class MigrationRunnerForChecks extends MigrationRunner {
  constructor(orm: IMigrationRunnerHost, protected checked: (driver: OrmDriver) => boolean) {
    super(orm);
  }

  protected plan(name: string | undefined, force: boolean, connection?: string): Array<[OrmDriver, IMigrationUnit[]]> {
    return super.plan(name, force, connection).filter(([driver]) => this.checked(driver));
  }
}

/**
 * Boot check: refuses to start on a database with pending or failed migrations. Asks each
 * connection's migration service for a read-only status and never creates or changes anything.
 *
 * A singleton on purpose: a migration tool resolves it with `{ Enabled: false }` first, and the
 * Orm resolving it afterwards must get that same disabled instance.
 */
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
    this.rejectOnStartup(orm);

    const failing: Findings = { pending: [], failed: [] };
    const warning: Findings = { pending: [], failed: [] };
    const entries = await new MigrationRunnerForChecks(orm, (d) => this.mode(d) !== 'off').status({ readOnly: true });

    for (const e of entries) {
      if (!e.pending && !e.failed) {
        continue;
      }

      const target = this.mode(orm.Connections.get(e.connection)) === 'warn' ? warning : failing;
      (e.failed ? target.failed : target.pending).push({ name: e.name, connection: e.connection });
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

  // A custom Migration.Service may report a connection name the Orm does not know: it gets the global mode.
  protected mode(driver: OrmDriver | undefined): MigrationCheckMode {
    return driver?.Options.Migration?.Check ?? this.Configuration.get<MigrationCheckMode>('db.MigrationCheck', 'fail');
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

  /** Independent of the Check mode: a config still relying on boot migrations must not start silently unmigrated. */
  protected rejectOnStartup(orm: IMigrationRunnerHost): void {
    // `Options.Name === name` skips the alias and `default` keys, so each connection is named once
    const keys = [...orm.Connections].filter(([name, driver]) => driver.Options.Name === name && driver.Options.Migration?.OnStartup !== undefined).map(([name]) => `db.Connections[${name}].Migration.OnStartup`);

    if (keys.length > 0) {
      throw new OrmException(`Migration.OnStartup is no longer supported (set in ${keys.join(', ')}): the application never migrates. Remove the key and run "npx spinajs migrate-up" as a deploy step.`);
    }
  }
}
