/**
 * `@spinajs/orm-cli` - the migration commands, as plain DI-resolvable classes.
 *
 * Importing this module does not by itself add commands to the bin: `Cli` ignores the
 * `__cli_command__` registration. The shipped `config/orm-cli` appends this package's `cli`
 * directory to `system.dirs.cli`, which is how `Cli` discovers them without the host application
 * importing anything by hand.
 *
 * Nothing here is exported from `@spinajs/orm`: the dependency runs one way only, from orm-cli to
 * orm, so the ORM stays usable ( and testable ) with no CLI in its dependency tree.
 */
export * from './orm.js';
export * from './cli/MigrateUp.js';
export * from './cli/MigrateDown.js';
export * from './cli/MigrateStatus.js';
export * from './cli/MigrateResolve.js';
export * from './cli/MigrateCreate.js';
export * from './migration-scaffold.js';
