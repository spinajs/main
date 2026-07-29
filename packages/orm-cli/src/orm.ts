import { DI } from '@spinajs/di';
import { IOrmOptions, Orm } from '@spinajs/orm';

/**
 * `Orm.resolve()` normally ends with a migration pass - every pending migration on every
 * connection whose `Migration.OnStartup` is on. For an application that is the point. For a
 * process whose entire job is to operate on those migrations it is a trap, twice over:
 *
 * - a connection holding a FAILED row refuses every migration run, so `DI.resolve(Orm)` throws
 *   before the command body starts - including `migrate-resolve`, the one command that exists to
 *   clear that row. The error even names `orm.Migration.resolve(...)` as the remedy, which by
 *   then is unreachable except by editing the tracking table or the config by hand.
 * - `migrate-status` would apply every pending migration and only then report - so the deploy
 *   gate asking "is this database current?" makes it current, answers "yes", and exits 0 with
 *   the DDL it was meant to gate already run.
 *
 * `migrate-up` and `migrate-down` take the same Orm: an operator running them explicitly gets
 * exactly the run they asked for, once, rather than a boot pass followed by their own. It is
 * what makes `migrate-up --fake` mean anything at all - a boot pass would have really applied
 * the migrations the flag says to only record.
 */
export const CLI_ORM_OPTIONS: IOrmOptions = { MigrateOnStartup: false };

/**
 * The Orm every command in this package runs against: fully resolved - connections, models,
 * value converters, `orm.Migration` - with the boot migration pass suppressed.
 *
 * The suppression is honoured by the resolve that CONSTRUCTS the Orm; `Orm` is a DI singleton,
 * so a host process that already resolved one gets that instance back and these options are
 * ignored. Right answer either way: in a CLI process this call is the first, and a host that
 * booted its own Orm has already run whatever its configuration asked for.
 */
export function resolveCliOrm(): Promise<Orm> {
  return DI.resolve(Orm, [CLI_ORM_OPTIONS]);
}
