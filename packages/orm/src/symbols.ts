/**
 * Symbols used for metadata storage
 */
export const MODEL_DESCTRIPTION_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');
export const MIGRATION_DESCRIPTION_SYMBOL = Symbol.for('MIGRATION_DESCRIPTOR');
export const SCHEMA_SYMBOL = Symbol.for('ORM_SCHEMA_SYMBOL');

/**
 * A migration class name carries its own creation timestamp - `SomeName_yyyy_MM_dd_HH_mm_ss` -
 * and that timestamp is the only ordering the runner has.
 *
 * Lives here rather than in `migration-runner.ts` ( which re-exports it for its existing public
 * import path ) because this module is a leaf with zero relative imports: `migration-runner.ts`
 * sits in a require cycle with `orm.ts` through `migration-service.js -> driver.js -> ... ->
 * orm.js`, and `migration-environment.ts` ( which also needs this regexp ) is itself required BY
 * `orm.ts`. Importing it from `migration-runner.js` would close that cycle one hop earlier.
 */
export const MIGRATION_FILE_REGEXP = /(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/;
