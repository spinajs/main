import type { SqlDialectProfile } from '@spinajs/manifest';

export type { SqlDialectProfile } from '@spinajs/manifest';

const PROFILE = Symbol.for('spinajs:orm:sql-dialect');

/**
 * `spinajs build` records the profile in the package's manifest fragment, where `spinajs doctor` and the ESLint
 * `typed-sql` rule read it without loading the driver. Pass a literal or a `const` the compiler can evaluate.
 */
export function SqlDialect(profile: SqlDialectProfile): ClassDecorator {
  return (target) => {
    Object.defineProperty(target, PROFILE, { value: profile, enumerable: false, configurable: true });
  };
}

export function sqlDialectOf(driver: abstract new (...args: never[]) => unknown): SqlDialectProfile | undefined {
  return (driver as unknown as Record<symbol, SqlDialectProfile | undefined>)[PROFILE];
}
