import { DI } from '@spinajs/di';
import { OrmMigrator } from '@spinajs/orm';

/**
 * The migrator every command in this package runs against, resolved without its boot pass: the run a command makes
 * is the one the operator asked for, `migrate-status` stays a report, and `migrate-resolve` reaches the FAILED row
 * a boot pass would refuse to run over. Resolving it resolves the Orm it injects.
 *
 * `OrmMigrator` is a DI singleton, so a host process that already resolved one gets that instance back and the
 * option is ignored; such a host has already run whatever its configuration asked for.
 */
export function resolveCliMigrator(): Promise<OrmMigrator> {
  return DI.resolve(OrmMigrator, [{ MigrateOnStartup: false }]);
}
