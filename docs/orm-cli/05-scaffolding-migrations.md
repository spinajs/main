# Scaffolding migrations

`migrate-create` writes a new migration class file named `<Prefix>_yyyy_MM_dd_HH_mm_ss.ts` and prints its path. It needs no database and resolves no `Orm`, so it works in a checkout whose connections are not configured.

```sh
spinajs migrate-create --name CreateInvoices
spinajs migrate-create --name CreateInvoices --dir ./src/migrations --connection reporting
spinajs migrate-create --name SeedDemoCustomers -e local
```

## How it works

1. `MigrateCreateCommand.execute(options)` takes `name`, `connection` (default `DEFAULT_MIGRATION_CONNECTION`, `'default'`) and `env`. `env` is `options.env`, or else `parseEnvArgv()` reads `--env <value>` or `--env=<value>` from `process.argv`.
2. It validates, throwing `InvalidArgument` before any file is touched:
   - `name` against `MIGRATION_NAME_REGEXP`;
   - `connection` against `CONNECTION_NAME_REGEXP`;
   - `env`, when set, against `ENV_NAME_REGEXP`, and not one of `test`, `spec`, `d`.
3. It builds the class name `<name>_<now as yyyy_MM_dd_HH_mm_ss>` with luxon `DateTime.now()`, local time.
4. It creates `dir` (default `DEFAULT_MIGRATION_DIR`, `'./src/migrations'`) recursively, relative to the process working directory.
5. It writes `<dir>/<class>.ts`, or `<dir>/<class>.<env>.ts`, from `migrationTemplate(cls, connection, env)` with the `wx` flag. An existing file throws `IOFail`; nothing is overwritten.
6. It prints the file path alone on stdout with `console.log`, then logs where the migration must live to be discovered.

## Options

| Option | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `-n, --name [name]` | `string` | required | `MIGRATION_NAME_REGEXP`: `/^[A-Za-z][A-Za-z0-9]*$/` | Class name prefix. The timestamp suffix is appended by the command |
| `-d, --dir [dir]` | `string` | `./src/migrations` | any path | Target directory, created when missing |
| `-c, --connection [connection]` | `string` | `default` | `CONNECTION_NAME_REGEXP`: `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` | Connection written into `@Migration('<connection>')` |
| `-e, --env [env]` | `string` | none | `ENV_NAME_REGEXP`: `/^[A-Za-z][A-Za-z0-9-]*$/`, not `test`, `spec` or `d` | Tags the migration for one environment: a `.<env>.ts` file suffix and `{ Env: '<env>' }` in the decorator. Omit for every environment |

`execute()` takes `IMigrateCreateCommandOptions`: `{ name: string; dir?: string; connection?: string; env?: string }`.

## Generated file

`spinajs migrate-create -n CreateInvoices -c reporting` writes `src/migrations/CreateInvoices_2026_10_17_14_05_09.ts`:

```ts
/* eslint-disable @typescript-eslint/no-unused-vars */
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/**
 * TODO: describe the schema change this migration makes.
 */
@Migration('reporting')
export class CreateInvoices_2026_10_17_14_05_09 extends OrmMigration {
  /**
   * Schema changes. Models are NOT wired up yet at this point - reach the database through
   * `connection`, never through a model class.
   */
  public async up(connection: OrmDriver): Promise<void> {
    // TODO: await connection.schema().createTable('table_name', (table) => { ... });
  }

  /**
   * Undoes `up()`. Leave it empty only when the change genuinely cannot be reversed - an empty
   * `down()` makes migrate-down report success while changing nothing.
   */
  public async down(connection: OrmDriver): Promise<void> {
    // TODO: await connection.schema().dropTable('table_name');
  }
}
```

With `-e local` the file is `CreateInvoices_<timestamp>.local.ts` and the decorator is `@Migration('reporting', { Env: 'local' })`.

## Exported building blocks

| Export | Kind | Value or signature |
| --- | --- | --- |
| `MIGRATION_NAME_REGEXP` | `RegExp` | `/^[A-Za-z][A-Za-z0-9]*$/` |
| `CONNECTION_NAME_REGEXP` | `RegExp` | `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` |
| `ENV_NAME_REGEXP` | `RegExp` | `/^[A-Za-z][A-Za-z0-9-]*$/` |
| `DEFAULT_MIGRATION_DIR` | `string` | `'./src/migrations'` |
| `DEFAULT_MIGRATION_CONNECTION` | `string` | `'default'` |
| `migrationTemplate(cls, connection, env?)` | function | Returns the file source above |
| `parseEnvArgv(argv = process.argv)` | function | Returns the value after `--env`, or of `--env=`, or `undefined` |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `MigrateCreateCommand` | Class token `MigrateCreateCommand`, singleton; also under `'__cli_command__'` | `MigrateCreateCommand` | none shipped | `DI.register(MySub).as(MigrateCreateCommand)` and override `execute()`. It has no smaller hook: `migrationTemplate()` is a module function the command calls directly, so overriding it on a subclass has no effect |
| Template | `migrationTemplate()` function, not a DI service | the scaffold above | none shipped | Write your own command that reuses the exported regexps, defaults and `migrationTemplate()`; see the example below |

### `MigrateCreateCommand`: open the new file in the editor

```ts sample
import { DI } from '@spinajs/di';
import { IMigrateCreateCommandOptions, MigrateCreateCommand } from '@spinajs/orm-cli';
import { spawn } from 'node:child_process';

/** Scaffolds as usual, then opens the newest file in $EDITOR when one is set. */
export class EditingMigrateCreateCommand extends MigrateCreateCommand {
  public async execute(options: IMigrateCreateCommandOptions): Promise<void> {
    const printed: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
      log(...args);
    };

    try {
      await super.execute(options);
    } finally {
      console.log = log;
    }

    const file = printed[0];
    if (file && process.env.EDITOR) {
      spawn(process.env.EDITOR, [file], { stdio: 'inherit', detached: true }).unref();
    }
  }
}

// In your own CLI entry point, before `DI.resolve(Cli)`:
DI.register(EditingMigrateCreateCommand).as(MigrateCreateCommand);
```

## Important behaviour

- **The timestamp is the only ordering the runner has.** It is read back from the class name, not from the file's date. Do not rename the class or the file.
- **The class runs only once it is discovered.** A file under the application's own `system.dirs.migrations` (or the ORM's fallback directories) is found automatically. A migration inside a package must be re-exported from that package's index, so `@Migration` runs and registers it; a package's own directories are never scanned at a consumer's runtime. See [Migrations: discovery directories](../orm/10-migrations.md#discovery-directories).
- **Two runs in the same second collide.** Both produce the same class name; the second throws `IOFail` instead of overwriting.
- **`--env` also switches the CLI process's environment.** The bin's argv provider strips `--env <value>` and `--env=<value>` before commander parses, and `@spinajs/configuration` boots under that environment. `parseEnvArgv()` reads the value back from `process.argv`. This is harmless here, because the command touches no database. `-e <value>` reaches commander and changes nothing else.
- **`parseEnvArgv()` reads `process.argv` when you call `execute()` directly.** A script started with `--env prod` that calls `execute({ name })` gets a `.prod.ts` file. Pass `env` explicitly to avoid it.
- **`test`, `spec` and `d` are refused as environments.** The ORM's file parser treats `.test.ts`, `.spec.ts` and `.d.ts` as file kinds, never as environment tags, and many test globs would run a `.test.ts` migration as a suite.
- **`--dir` is relative to the working directory**, not to the application or package root.
- **The prefix allows no underscores or digit groups that look like a timestamp.** The runner splits the class name on the last `_yyyy_MM_dd_HH_mm_ss` run.

## Best practices

- Name the prefix after the change, in PascalCase: `CreateInvoices`, `AddInvoiceIndex`.
- Use `$(spinajs migrate-create -n CreateInvoices)` in scripts; the path is the first stdout line the command prints. The bin's welcome line goes through the logger, so route log targets away from stdout when you capture it.
- Fill in `down()` right away. An empty `down()` makes `migrate-down` report success while changing nothing.

## Patterns and antipatterns

```sh
# Don't: the suffix is appended by the command; this is refused
spinajs migrate-create --name CreateInvoices_2026_10_17_14_05_09

# Don't: underscores are refused, they confuse the timestamp parse
spinajs migrate-create --name create_invoices

# Do
spinajs migrate-create --name CreateInvoices
```

## Examples

### A `migrate-create:table` command with a filled-in template

A separate command, built from the exported pieces, that scaffolds a `createTable` migration.

```ts sample
import { CliCommand, Command, Option } from '@spinajs/cli';
import { InvalidArgument, IOFail } from '@spinajs/exceptions';
import { CONNECTION_NAME_REGEXP, DEFAULT_MIGRATION_CONNECTION, DEFAULT_MIGRATION_DIR, migrationTemplate } from '@spinajs/orm-cli';
import { DateTime } from 'luxon';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface CreateTableOptions {
  table: string;
  connection?: string;
}

// spinajs migrate-create:table --table invoices
@Command('migrate-create:table', 'Scaffolds a migration that creates one table')
@Option('-t, --table <table>', true, 'table name, snake_case')
@Option('-c, --connection [connection]', false, 'connection the migration runs on')
export class MigrateCreateTableCommand extends CliCommand {
  public async execute(options: CreateTableOptions): Promise<void> {
    const connection = options.connection ?? DEFAULT_MIGRATION_CONNECTION;
    if (!/^[a-z][a-z0-9_]*$/.test(options.table) || !CONNECTION_NAME_REGEXP.test(connection)) {
      throw new InvalidArgument('table must be snake_case and connection a configured connection name');
    }

    const prefix = 'Create' + options.table.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
    const cls = `${prefix}_${DateTime.now().toFormat('yyyy_MM_dd_HH_mm_ss')}`;
    const source = migrationTemplate(cls, connection)
      .replace("// TODO: await connection.schema().createTable('table_name', (table) => { ... });", `await connection.schema().createTable('${options.table}', (table) => {\n      table.int('Id').primaryKey().autoIncrement();\n    });`)
      .replace("// TODO: await connection.schema().dropTable('table_name');", `await connection.schema().dropTable('${options.table}');`);

    const file = path.join(DEFAULT_MIGRATION_DIR, `${cls}.ts`);
    fs.mkdirSync(DEFAULT_MIGRATION_DIR, { recursive: true });
    try {
      fs.writeFileSync(file, source, { flag: 'wx', encoding: 'utf-8' });
    } catch (err) {
      throw new IOFail(`Migration file ${file} already exists`, err as Error);
    }

    console.log(file);
  }
}
```

Put it in its own file in your application's `system.dirs.cli` directory, as the only export.

## Related

- [Migrations: writing a migration](../orm/10-migrations.md#writing-a-migration): `up()`, `down()`, `data()` and `transaction`.
- [Migrations: environments](../orm/10-migrations.md#environments): how the `.<env>.ts` suffix and `Env` are read back.
- [Schema builder](../orm/09-schema-builder.md): what to write inside `up()`.
