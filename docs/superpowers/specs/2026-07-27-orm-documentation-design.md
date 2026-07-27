# ORM documentation — design

Date: 2026-07-27

## Goal

Exhaustive, feature-grouped prose documentation for the ORM family of `@spinajs`
packages. The packages currently ship `README.md` stubs containing only
`> TODO: description`, and their `typedoc.json` files produce symbol dumps with no
narrative. Nothing explains how to define a model, build a query, wire a relation, or
expose a model over HTTP.

## Scope

In scope, each with its own `docs/` folder:

| Package | Emphasis |
| --- | --- |
| `@spinajs/orm` | Core. Decorators, model API, query builders, relations, unit of work, schema/migrations, architecture. |
| `@spinajs/orm-sql` | Shared SQL statement/compiler layer; how a dialect driver is built on it. |
| `@spinajs/orm-http` | Integration with `@spinajs/http`: route args, filtering, DTO relations. |
| `@spinajs/orm-api` | Generated JSON:API CRUD controller. |
| `@spinajs/orm-sqlite` | Dialect driver notes. |
| `@spinajs/orm-mysql` | Dialect driver notes. |
| `@spinajs/orm-mssql` | Dialect driver notes. |

Out of scope: `orm-threading`, `intl-orm`, `queue-orm-transport`, and downstream
consumers (`rbac`, `session-provider-db`, `configuration-db-source`).

## Audience and depth

Two layers in every package:

1. **User guide** — task-oriented, sample-first. How to do the thing.
2. **Architecture** — how it works inside, for people extending or debugging it.

The architecture material is not filler. The ORM source carries a number of
non-obvious invariants documented only in code comments (composite-key join column
defaults, inherited-descriptor detachment, positional key backfill after a multi-row
insert on dialects without `RETURNING`). Those belong in prose.

## Layout

```
packages/<pkg>/docs/README.md      index + reading order
packages/<pkg>/docs/NN-topic.md    one feature group per file
packages/<pkg>/README.md           short real overview, links into docs/
```

### Collision with typedoc

`packages/*/docs/` was already the typedoc output directory: gitignored in both the root and
each package's own `.gitignore`, and destroyed on every run by
`"build-docs": "rimraf docs && typedoc ..."`. Prose placed there would never be committed and
would be deleted by the next docs build.

Resolved by treating prose as source and generated HTML as an artifact — the generated output
moves, the prose stays where it was specified. In all seven packages:

- `typedoc.json` — `"out": "docs"` → `"out": "api-docs"`
- `package.json` — `rimraf docs` → `rimraf api-docs`
- root `.gitignore` — `packages/*/docs/` → `packages/*/api-docs/`
- each package `.gitignore` — `docs` → `api-docs`

`packages/orm/docs/` holds 13 numbered files plus an index:

1. `01-getting-started.md`
2. `02-configuration.md`
3. `03-models-and-decorators.md`
4. `04-static-model-api.md`
5. `05-instance-api.md`
6. `06-query-builder.md`
7. `07-relations.md`
8. `08-unit-of-work.md`
9. `09-transactions.md`
10. `10-schema-and-migrations.md`
11. `11-converters-and-hydration.md`
12. `12-architecture.md`
13. `13-observability.md`

Satellite packages get 4–6 files each on the same pattern.

## Code samples

Samples are derived from the packages' own test suites and mock models, then reshaped
into idiomatic application code rather than test code. Nothing is invented: every
decorator, method, option name and behaviour claim traces to source.

### Verification

`scripts/check-doc-samples.mjs`:

1. Walks `packages/*/docs/**/*.md`.
2. Extracts fenced blocks whose info string is `ts sample`.
3. Writes each to `.tmp/docs-samples/<pkg>/<file>-<n>.ts`.
4. Emits a `tsconfig.json` beside them and runs `tsc --noEmit`.

Each tagged block is self-contained and carries its own imports. Blocks that are
deliberately partial use a plain ` ```ts ` fence and are skipped. Non-TypeScript
fences (`sql`, `json`, `bash`) are ignored.

Root `package.json` gains `"docs:check"`. Because npm workspaces resolve
`@spinajs/*` to each package's built `lib/`, `npm run build` must precede
`docs:check`. No CI wiring — the script is invoked manually.

## Non-goals

- Replacing typedoc. The prose links to it, it does not enumerate every symbol
  signature.
- Refactoring ORM source. Where the code has rough edges, the docs describe the
  behaviour as it is and flag the sharp edge.
- Documenting packages that merely consume the ORM.
