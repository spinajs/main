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
| `--allow-destructive` | Write `DESTRUCTIVE` steps as code; without it they are comments |
| `--sql` | Print the DDL for the connection's dialect instead of writing a file. A step the dialect only runs against the live table (sqlite column changes) prints as a `--` line |
| `--check` | Write nothing; print the changes and exit 1 when there are any. Use it in CI to catch "model changed, no migration" |

stdout carries the result (the file path, the DDL, or the change list); diagnostics (`MIG001`–`MIG006`) go to stderr. `MIG001` stops the command with exit code 1. `MIG006` warns that a generated sqlite column change would fail while foreign keys are enforced, before the migration runs. The command connects like the other migration commands (`OrmMigrator` without its boot pass), so it works while tables are still missing.
