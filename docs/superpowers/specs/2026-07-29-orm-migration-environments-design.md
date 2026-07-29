# Per-environment ORM migrations

Status: approved design, not yet implemented.

## Problem

Every registered migration runs on every deployment. There is no way to say "this
one seeds test data, run it on my machine only" or "dev and prod need different
starting rows". Today the only lever is not importing the file, which is a source
change rather than a deployment property.

`@spinajs/configuration` already solved the same problem for config files: a file
with no dot-suffix loads always, `foo.dev.js` loads only under `APP_ENV=dev`
([`packages/configuration/src/sources.ts`](../../../packages/configuration/src/sources.ts)).
Migrations should use that same convention.

## Constraint this design had to work around

Migrations are registered by **import**, not by scanning the filesystem.
`@Migration()` calls `DI.register(target).as('__migrations__')`
([`packages/orm/src/decorators.ts:141`](../../../packages/orm/src/decorators.ts)) and
`Orm.resolve()` pulls the classes back out of DI
([`packages/orm/src/orm.ts:172-178`](../../../packages/orm/src/orm.ts)). The class name is
the migration's identity everywhere downstream — it is what
`MigrationRunner.plan()` orders on and what lands in the tracking table's
`Migration` column.

So the file a migration was declared in never reaches the runner, and a filename
suffix has no channel today. The feature therefore needs a filesystem discovery
path that does not exist yet.

## Decisions

| Question | Decision |
| --- | --- |
| How is env declared? | Both: filename suffix (via new file discovery) and a decorator option, for migrations registered by import |
| Discovery shape | Injectable `MigrationSource` service, mirroring `@spinajs/http`'s `ControllerSource` |
| Which env value? | Same normalization as configuration file loading |
| Non-matching migration | Fully invisible — absent from `up`, `down` and `status` |
| Envs per migration | Exactly one |
| CLI | `migrate-create --env <name>` only; no `--env` override on up/down/status |
| `system.dirs.migrations` default | `src`/`lib`/`dist` `/migrations` off cwd |
| Suffix and decorator disagree | Throw |

## Design

### 1. Env resolution — one source of truth

`BaseFileSource.getEnvironment()`
([`sources.ts:192`](../../../packages/configuration/src/sources.ts)) is currently a protected
method holding the normalization rules. Its body moves into a pure exported
function in `@spinajs/configuration-common`:

```ts
export function normalizeEnvironment(env?: string): string;
```

Rules, unchanged from today: `dev` and `development` both normalize to `dev`,
`prod` and `production` to `prod`, anything else passes through verbatim, absent
becomes `prod`.

`BaseFileSource.getEnvironment()` keeps its signature and delegates to it, so
config loading behavior does not move. ORM resolves the current env as
`normalizeEnvironment(configuration.get('process.env.APP_ENV'))`.

`@spinajs/orm` already depends on `@spinajs/configuration-common`, so this adds no
dependency. Consequence worth stating: `Foo.dev.ts` runs under both `APP_ENV=dev`
and `APP_ENV=development`, exactly as `foo.dev.js` config already does.

### 2. `MigrationSource` — injectable discovery

Mirrors [`packages/http/src/controller-sources.ts`](../../../packages/http/src/controller-sources.ts)
in both shape and intent — sources only *discover* types, they never resolve them:

```ts
export abstract class MigrationSource extends AsyncService {
  public abstract getMigrations(): Promise<Array<ClassInfo<OrmMigration>>>;
}

@Injectable(MigrationSource)
export class FilesystemMigrationSource extends MigrationSource { /* scans system.dirs.migrations */ }

@Injectable(MigrationSource)
export class DiRegistryMigrationSource extends MigrationSource { /* existing '__migrations__' registry */ }
```

A deployment plugs in another discovery mechanism by implementing the abstract
class and decorating it `@Injectable(MigrationSource)`.

`ClassInfo.file` carries the origin path — from the filesystem source, the file it
was globbed from; from the DI source, the path `@Migration` captured at decoration
time (§4), falling back to the sentinel `<di>` when capture failed. That path is
what the suffix rule in §5 keys off.

#### Why `FilesystemMigrationSource` does not use `@ListFromFiles`

Two reasons, the second decisive:

1. The decorator's glob is fixed at decoration time, and the env-specific glob is
   only known at runtime.
2. `ListFromFiles` **imports** every file it finds
   ([`packages/reflection/src/index.ts:156`](../../../packages/reflection/src/index.ts)).
   Importing fires `@Migration`, which registers the class into `__migrations__`
   as a side effect. A `.local` file merely *listed* on a prod box would then be
   picked up by `DiRegistryMigrationSource` no matter what filter ran afterwards.

So non-matching files must never be imported at all. The source globs directly —
`@spinajs/orm` already depends on `glob`, and this avoids a new dependency on
`@spinajs/reflection`, which pulls in `typescript`.

Two passes per configured directory, mirroring `JsFileSource`
([`sources.ts:208`](../../../packages/configuration/src/sources.ts)):

- `/**/!(*.*).{ts,js}` — no dot in the basename, so these run in every env. The
  pattern also excludes `*.d.ts` for free.
- `/**/*.${env}.{ts,js}` — this env only.

Directories come from `system.dirs.migrations`, defaulting to `src/migrations`,
`lib/migrations` and `dist/migrations` off `process.cwd()` — the same directory
`migrate-create` writes to by default. Shipped in a new
`packages/orm/src/config/orm.ts`, following the `system.dirs` convention every
other package config already uses.

A file that fails to import is logged as a warning and skipped, never fatal. This
is reachable in normal operation: the default dirs include `src/migrations`, so a
compiled deployment will try to `__spinajs_require__` a `.ts` file and fail.

### 3. Filename grammar

```
Foo_2026_07_29_10_00_00.ts             every env
Foo_2026_07_29_10_00_00.local.ts       APP_ENV=local only
Foo_2026_07_29_10_00_00.dev.ts         APP_ENV=dev or development
Foo_2026_07_29_10_00_00.local.dev.ts   OrmException - one env per migration
```

The env tag is the single dot-segment between the class name and the extension.
Two or more segments throw, naming the file.

The timestamp inside the class name is untouched — it remains the only ordering
the runner has, and `MIGRATION_FILE_REGEXP` still reads it out of the class name,
never the file name.

### 4. Decorator

```ts
export function Migration(connection: string, options?: { Env?: string })
```

`IMigrationDescriptor` gains `Env?: string`. The existing single-argument form is
untouched, so every current migration keeps working.

This exists for migrations registered by import rather than discovery — a package
re-exporting its migrations from `index.ts` has no file path in play, so the
suffix cannot reach it.

#### `SourceFile` capture

`@Migration` also stamps `IMigrationDescriptor.SourceFile` with the file it was
applied in, using the same V8-stack technique `@Controller` already uses
(`captureControllerSourceFile` in
[`packages/http/src/decorators.ts:97`](../../../packages/http/src/decorators.ts)), and
`DiRegistryMigrationSource` reports it as `ClassInfo.file` instead of `<di>`.

Without it there is a hole the decorator option alone does not close: an app that
imports `Foo_2026_07_29_10_00_00.local.ts` from its `index.ts` — with no `Env` on
the decorator — registers it through DI under every env, suffix and all, and the
file discovery that would have filtered it never sees it because it is not in a
scanned directory. Capturing the path makes the suffix rule apply wherever the
class was declared, not only where it was found.

The capture is best-effort: a bundler that mangles paths, or an exotic runtime
whose stack frames do not carry them, yields `undefined` and the entry falls back
to `<di>` with the decorator as its only env signal. That is precisely the case
the decorator option is for.

### 5. Merge and filter, in `Orm.resolve()`

Replaces the `DI.getRegisteredTypes('__migrations__')` block at
[`orm.ts:172-178`](../../../packages/orm/src/orm.ts):

1. Resolve every registered `MigrationSource`, concatenate the results.
2. Resolve each entry's env *before* deduping, from its filename suffix and its
   decorator `Env`. Both present and disagreeing throws an `OrmException` naming
   the file, the suffix and the decorator value. Agreement is fine and is what
   `migrate-create --env` produces.
3. Dedupe by class name. Collisions are the normal case, not the exception:
   `src/` and `lib/` hold the same class, and a discovered file is nearly always
   also imported somewhere — which is exactly why env is resolved first. A plain
   first-wins dedupe would let whichever entry happened to be seen first decide,
   and dropping a `.local` tag that way lets the migration run everywhere.
   Instead the rule is over the *defined* env values among entries sharing a
   name: an absent env is not a vote and never conflicts, one distinct value wins
   for the merged entry, two or more distinct values throw naming both origins.
   If they share a name but carry different `type` objects, keep the first and log
   a warning naming both files.
4. Keep an entry when its env is absent, or equals the current env. Otherwise drop
   it with a trace line.
5. `registerMigration` the survivors.

Filtering here rather than in `MigrationRunner.plan()` is what makes a
non-matching migration **fully invisible**: it is absent from `up`, `down` and
`status` alike, because it never enters `Orm.Migrations` at all.

### 6. Accepted consequences

Three, all of them chosen deliberately.

**An env-tagged migration applied under one env looks like an orphan under
another.** Its row stays in the tracking table while its unit is gone, so
`migrate-down` reports it as "recorded as applied but no registered migration
matches them (file deleted or renamed)"
([`migration-service.ts:788`](../../../packages/orm/src/migration-service.ts)) and advises
restoring the file or removing the row — guidance that is wrong here, since
nothing is actually broken. This is the price of full invisibility.

**cwd defaults change behavior for existing apps.** An app holding migration files
under `src/migrations` that it deliberately never imported will now discover,
register and apply them on the next boot, with no config change on its part.

**`src` and `lib` are both scanned.** In a compiled deployment the `.ts` copies
fail to import; those failures are warnings, and the `.js` copy of the same class
wins the dedupe.

### 7. CLI

`migrate-create --env <name>` writes `Foo_2026_07_29_10_00_00.local.ts` and emits
`@Migration('default', { Env: 'local' })` into the scaffold.

Both, deliberately: the two agree so the conflict check passes, and the tag
survives whichever way the file ends up registered — discovered from disk, or
re-exported from an `index.ts`. The env name is validated against the same kind of
charset guard `--name` and `--connection` already carry
([`MigrateCreate.ts:20-26`](../../../packages/orm-cli/src/cli/MigrateCreate.ts)).

No `--env` override on `migrate-up` / `migrate-down` / `migrate-status`. The env
comes from `APP_ENV` (or configuration's own `--env`) and nowhere else, so the CLI
and the application boot can never disagree about which migrations exist.

## Testing

Unit:

- `normalizeEnvironment` — the alias table, pass-through, and the absent case.
- Filename parsing — no suffix, one suffix, two suffixes (throws), `.d.ts`.
- Conflict between suffix and decorator throws, naming both.
- Agreement between suffix and decorator does not throw.
- Dedupe keeps one entry per class name and warns on differing types.
- Dedupe env merge — absent plus `local` yields `local`; `local` plus `dev`
  throws; absent plus absent stays absent.
- `@Migration` captures `SourceFile`, and a subclass in another file captures its
  own rather than inheriting the parent's.
- Env filter keeps untagged and matching, drops non-matching.

Integration, on sqlite:

- `APP_ENV=local`: the `.local` migration is applied and appears in `status`.
- `APP_ENV=prod`: the same migration is absent from `status` entirely, and its
  table was never created.
- A migration registered by import with `{ Env: 'local' }` behaves identically
  under both envs.
- A non-matching `.local` file is never imported — asserted by a module-level side
  effect in the fixture that must not fire.

## Documentation

New section in
[`packages/orm/docs/10-schema-and-migrations.md`](../../../packages/orm/docs/10-schema-and-migrations.md)
covering the suffix convention, the decorator option, `system.dirs.migrations`,
writing a custom `MigrationSource`, and the orphan-warning consequence from §6.
