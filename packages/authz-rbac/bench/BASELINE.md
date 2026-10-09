# authz-rbac bench: canvas `file:read` list (release gate 7)

Plan task L4b.9 and release gate 7 (r3): "canvas `file:read` list over 1,000 files with rules ≤ 2 × the plain
`EXISTS` query on Postgres". Results: `RESULTS.md`.

## Run it

From `packages/authz-rbac`, with the lane's Postgres up (`127.0.0.1:15432`, see `test/support/db.ts`):

```
L2_REQUIRE_PG=1 npm run bench -- --filter=postgres.jit-off > out.txt 2>&1
L2_REQUIRE_PG=1 npm run bench -- --filter=postgres.jit-on
L2_REQUIRE_PG=1 npm run bench -- --filter=sqlite
L2_REQUIRE_PG=1 L4B_BENCH_BACKGROUND=90 npm run bench -- --filter=postgres.jit-off
```

- `--filter=<substring>` picks scenarios by name, `--repeats=<n>` overrides every scenario's repeats, `--scale=<x>`
  scales iterations and warm-up (smoke runs only).
- Prints the kit's table, then the gate table (each list against its reference, p50 and p99 ratios); writes one
  `bench/out/<name>.json` per scenario (git-ignored) with every repeat and the environment, and prints what each
  database holds (row counts, server version, `jit*` settings, the authz tables' indexes).
- Postgres JIT off takes about 15 minutes, JIT on about two hours (each list compiles for seconds), SQLite about 35
  minutes. Run one mode at a time on a quiet machine: other suites on the same Postgres server skew the numbers.
- The runner and the timing come from the kit (`packages/authz-testing/bench/lib.ts`, imported, not copied): the
  kit's runner reads only its own `scenarios/` directory, so this bench has its own `run.ts` with the gate table.

## The world

`lib.ts` `canvasState(seed = 7, background = 0)`: the design §8.5 canvas over the kit's fixture config
(`packages/authz-testing/fixtures/canvas-c6/config.snapshot.json`, its `capabilities.json` for the branch rule
permissions, the kit's org attribute schema), scaled:

- 10 orgs with the policy shapes of `state.json` (ACME defaults, STRICT, OPEN) and one with external sharing off,
  written as `authz_scope_attribute` rows; per org an owner, 2 admins, 20 members, 4 guests, 2 file guests, 3 groups
  of 6 members;
- 5 projects per org: `org_default_role` viewer ×3, commenter, none (a subject-set assignment), 4 user grants with
  random roles and add-ons, a group grant; 3 branch rules each (`main`, `release/*`, `*-lts`) as 6 stored thresholds
  at the project (`resourceTypes: ['branch']`); a share link at the project;
- 20 files per project, 1,000 in all: a link at the first, a user grant on every third, an external user's grant on
  every tenth, a stored restrict rule (file restriction) on every fifteenth, allowing one or two members or a group;
- `L4B_BENCH_BACKGROUND=<n>`: `n` more orgs (other tenants) with the same data in the authz tables and the org,
  project and group tables, but no rows in the file table, so the list still reads 1,000 files.

About 1,300 assignments, 350 stored rules, 25 attribute rows (×10 with 90 background orgs). Written as a host writes
them: `DbAssignmentStore.assign`, `DbRuleStore.putWithLadders` (SQL-form columns), `DbScopeAttributeStore.write`, in
one transaction; then `ANALYZE`. The domain is wired as a host wires authz-orm and authz-rbac (`registerRbac`,
`ConfigRoleStore` from the config, `DbAssignmentStore`, `ConfigRuleStore` + `DbRuleStore`, the list extension with
`rules: true`, `DbScopeAttributeStore`, ABAC with the canvas policy), over the migrations' tables and indexes
(`authz_assignment_scope`, `authz_rule_scope`, the `authz_scope_attribute` primary key).

The canvas config has no `file:read`: reading a file is C6 `project.read`, permission `project:read` on type
`file`. The file model is `@AccessResource('file', { permissions: { read: 'project:read' } })` with `project_id`
and `org_id` scope columns, so authz-orm's middleware filters `project:read` when the file table is queried.

Principals: `owner` (org.owner of org 1: implies maintainer, bypasses restrict and cap), `member` (org.member of
orgs 1-2, a group, a project and a file grant), `member-all` (org.member of all 10 orgs), `guest` (org.guest of the
STRICT org with two maintainer project grants), `external` (no org role; project grants in the OPEN org and in the
org with external sharing off, file grants in a fifth org), `link` (a share link principal, viewer at a project).

## The scenarios

`scenarios/01-canvas-file-list.ts`, named `canvas[.bg<n>].<postgres.jit-off|postgres.jit-on|sqlite>.<principal>.<op>`:

| op           | times                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`       | (a) the list as an app runs it: `File.query()` under the principal; authz-orm's middleware filters `project:read` (args v2 with the config rules and `dbRules`, `native:rbac.threshold`) and compiles it; one statement                    |
| `exists`     | (b) the reference: the r2 `native:rbac.assignment` v1 term (design §6.1.3, the plain `EXISTS`) for the same principal without rules: the list's subjects and every role its routes accept, compiled by authz-orm on the same table and run |
| `list-sql`   | (a), the statement only: its text and bindings run on the driver (no filter, no compile)                                                                                                                                                   |
| `exists-sql` | (b), the statement only                                                                                                                                                                                                                    |

The gate table compares `list` with `exists` and `list-sql` with `exists-sql`, p50 and p99, each over the median of
the repeats; a row passes at ≤ 2 for both.

Before any timing, once per database and principal, the setup checks that the list is exactly the files single
checks allow (1,000 `check` calls through the in-memory pipeline, the oracle of B44), that the reference holds every
listed row, and that each operation runs one statement; each scenario's `verify` checks the row count of its
operation.

JIT: the bench database is its own (`l2_l4b_bench_postgres_<hex>`, dropped at the end); the bench sets `jit` with
`ALTER DATABASE … SET jit = on|off` on it and reconnects the pool (new sessions read it; `SHOW jit` is checked).
Nothing is set on the server.
