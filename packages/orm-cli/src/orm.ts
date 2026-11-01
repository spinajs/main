import { OrmMigrator, resolveMigrationTool } from '@spinajs/orm';

/**
 * The migrator every command in this package runs against, resolved without its startup migrations: the run a command
 * makes is the one the operator asked for, `migrate-status` stays a report, and `migrate-resolve` reaches the FAILED
 * row a startup run would refuse to run over.
 *
 * `OrmMigrator` is a DI singleton, so a host process that already resolved one gets that instance back and the
 * option is ignored; such a host has already run whatever its configuration asked for.
 */
export function resolveCliMigrator(): Promise<OrmMigrator> {
  return resolveMigrationTool();
}
