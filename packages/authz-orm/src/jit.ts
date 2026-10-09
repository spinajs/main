import { AuthzConfigError } from '@spinajs/authz';
import type { OrmDriver } from '@spinajs/orm';

// With jit on, Postgres compiles the rule lists' statements for seconds per query (L4b bench, RESULTS.md).
const shown = new WeakMap<object, Promise<unknown>>();

interface DriverOptions {
  readonly Driver?: unknown;
  readonly Name?: unknown;
  readonly User?: unknown;
  readonly Database?: unknown;
}

const optionsOf = (driver: unknown): DriverOptions | undefined => (driver as { Options?: DriverOptions } | null | undefined)?.Options;

const isPostgres = (driver: unknown): driver is OrmDriver => optionsOf(driver)?.Driver === 'orm-driver-postgres';

/** The driver's `SHOW jit`, asked once; a SHOW that fails is forgotten, so the next use asks again. */
function jitOf(driver: OrmDriver): Promise<unknown> {
  let hit = shown.get(driver);
  if (hit === undefined) {
    const asked = (async () => ((await driver.schema().raw('SHOW jit')) as { jit?: unknown }[] | undefined)?.[0]?.jit)();
    asked.catch(() => {
      if (shown.get(driver) === asked) shown.delete(driver);
    });
    shown.set(driver, (hit = asked));
  }
  return hit;
}

const ident = (value: unknown, fallback: string): string => (typeof value === 'string' && value !== '' ? `"${value.replace(/"/g, '""')}"` : fallback);

/**
 * Refuses a Postgres driver whose sessions run with `jit = on`, unless `allowJit` (`authz.orm.allowJit`) is true.
 * Any other driver passes without a statement.
 */
export async function assertJitOff(driver: unknown, allowJit: () => unknown): Promise<void> {
  if (!isPostgres(driver) || allowJit() === true) return;
  if ((await jitOf(driver)) !== 'on') return;
  const o = optionsOf(driver)!;
  throw new AuthzConfigError(`authz-orm: Postgres connection ${JSON.stringify(String(o.Name))} runs with jit = on, which makes authorized lists take seconds; run ALTER ROLE ${ident(o.User, '<role>')} SET jit = off or ALTER DATABASE ${ident(o.Database, '<db>')} SET jit = off, or start the process with PGOPTIONS='-c jit=off', or set authz.orm.allowJit: true to accept slow lists`);
}
