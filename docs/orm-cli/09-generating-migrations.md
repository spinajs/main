# Generating migrations from models

`spinajs migrate-diff` compares the schema the app's models declare (from `app.manifest.json`) with a live database and writes a migration over the schema builder that closes the gap. The rules (partial models, unmanaged columns, what is compared) are in the orm's [schema diff](../orm/19-schema-diff.md) page.

```bash
spinajs migrate-diff AddEmailVerified --connection default
# src/migrations/AddEmailVerified_2026_11_03_10_20_30.ts
```

| Option | Meaning |
|---|---|
| `[name]` | Class-name prefix, letters and digits; default `SchemaDiff` |
| `-c, --connection` | Connection to compare; models naming it, one of its aliases, or (for the default connection) no connection count. Default `default` |
| `-m, --manifest` | App manifest; default `app.manifest.json` |
| `-b, --base` | Manifest the database was last generated from. A column it declares and the current one does not is dropped (`DESTRUCTIVE`) |
| `-o, --out` | Directory for the file; default `./src/migrations` |
| `-p, --prune` | `table.column,…` of undeclared columns to drop (`DESTRUCTIVE`) |
| `--package` | `name,…` of the packages whose models count, besides the app's own; default every package in the manifest |
| `--exclude-package` | `name,…` of the packages whose models do not count |
| `--allow-destructive` | Write `DESTRUCTIVE` steps as code; without it they are comments |
| `--sql` | Print the DDL for the connection's dialect instead of writing a file. A step the dialect only runs against the live table (sqlite column changes; the recorder answers no rows) prints as a `--` line, and so does a `DESTRUCTIVE` step without `--allow-destructive` |
| `--check` | Write nothing; print the changes and exit 1 when there are any. Use it in CI to catch "model changed, no migration" |

stdout carries the result (the file path, the DDL, or the change list); diagnostics (`MIG001`–`MIG006`) go to stderr. An error diagnostic (`MIG001`, `MIG006`) stops the command with exit code 1: no file is written, `--sql` prints no DDL and `--check` lists no changes. `MIG006` means a sqlite column change that will run would rebuild a table other tables reference, and the connection enforces foreign keys, so the rebuild would fail; with foreign keys off it is not raised and the migration is written. To proceed, take that column change out of the models, generate the rest, and alter the table in a hand-written migration with `public transaction = false` (sqlite ignores `PRAGMA foreign_keys` inside a transaction, and a configured [`Migration.Transaction.Mode`](../orm/10-migrations.md#transaction-modes) would wrap the migration in one) that runs `PRAGMA foreign_keys = OFF` through `connection.schema().raw()` before the change and turns it back `ON` in a `finally`. It checks only the tables a model or `--base` maps; for a referencing table no model maps, the driver's `NotSupported` error when the step runs is the backstop. The command connects like the other migration commands (`OrmMigrator` without its boot pass), so it works while tables are still missing.

## Models of packages the app does not use

The manifest lists the models of every package reachable through the app's dependencies, including packages the app never imports (a scheduler package a dependency ships, for example). Their tables then come out as `createTable` lines. The manifest records which package declares each model, but not which packages the app imports, so name them:

```bash
spinajs migrate-diff --check --exclude-package @spinajs/scheduler
spinajs migrate-diff --check --package @spinajs/users,@spinajs/teams
```

`--package` keeps the app's own models and those of the named packages; `--exclude-package` drops the named ones, and wins when a package is in both. A table counts while any model of a counted package maps to it, columns included. The same filter applies to the `--base` manifest, so the table of an excluded package is never dropped; neither is a table the filter left out that a current model still maps, whichever package mapped it in `--base`. Names are checked against the current manifest only: a name it does not list (neither the app nor one of its packages) stops the command with `Unknown package …`, even when the `--base` manifest lists it.
