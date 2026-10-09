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

const connection = (o: DriverOptions): string => (typeof o.Name === 'string' && o.Name !== '' ? `Postgres connection ${JSON.stringify(o.Name)}` : 'a Postgres connection without a Name');

const answered = (jit: unknown): string => (jit === undefined ? 'no row' : typeof jit === 'string' ? JSON.stringify(jit) : String(jit));

/**
 * Refuses a Postgres driver whose sessions run with `jit = on`, unless `allowJit` (`authz.orm.allowJit`) is true,
 * and one whose `SHOW jit` answers neither `on` nor `off`. Any other driver passes without a statement.
 */
export async function assertJitOff(driver: unknown, allowJit: () => unknown): Promise<void> {
  if (!isPostgres(driver) || allowJit() === true) return;
  const jit = await jitOf(driver);
  if (jit === 'off') return;
  const o = optionsOf(driver)!;
  if (jit !== 'on') throw new AuthzConfigError(`authz-orm: the jit check could not read jit on ${connection(o)}: SHOW jit answered ${answered(jit)}`);
  throw new AuthzConfigError(`authz-orm: ${connection(o)} runs with jit = on, which makes authorized lists take seconds; run ALTER ROLE ${ident(o.User, '<role>')} SET jit = off or ALTER DATABASE ${ident(o.Database, '<db>')} SET jit = off, or start the process with PGOPTIONS='-c jit=off', or set authz.orm.allowJit: true to accept slow lists`);
}
