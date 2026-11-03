import { OrmMigrator, resolveMigrationTool } from '@spinajs/orm';

/**
 * The migrator every command in this package runs against, over an Orm booted without the boot guard: `migrate-status`
 * reports pending work instead of refusing to start over it, and `migrate-resolve` reaches the FAILED row an
 * application's boot refuses.
 *
 * A host process that already resolved its Orm gets that one back, booted with whatever check it ran.
 */
export function resolveCliMigrator(): Promise<OrmMigrator> {
  return resolveMigrationTool();
}
