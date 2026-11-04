# orm-conformance (private)

Differential tests for the ORM. One corpus of cases runs on every target, and each target's results must equal
PGlite's (the postgres compilers on a real PostgreSQL, in process). Not published.

## Running

```bash
cd packages/orm-conformance
npm test                                                     # sqlite + PGlite
ORM_CONFORMANCE_POSTGRES=postgres://postgres:postgres@127.0.0.1:15432/test \
ORM_CONFORMANCE_MYSQL=mysql://root:root@127.0.0.1:13306/test \
ORM_CONFORMANCE_MSSQL='mssql://sa:yourStrong(!)Password@127.0.0.1:1433/test' \
npm test                                                     # + the docker-compose servers
```

`docker compose --profile test up -d postgres mysql mssql mssql-init` starts the servers. Each run drops and
recreates the `cf_*` tables in the given database.

## A case

```ts
defineCase({
  name: 'where-eq',                 // kebab-case, unique
  seed: BASE,                       // rows inserted into a freshly created fixture
  order: 'unordered',               // rows are sorted before comparison
  booleans: ['Active'],             // optional: keys whose 0/1 are booleans in raw rows
  run: async () => (await CfUser.where('Age', 31)).map((u) => u.Name),
});
```

`run` returns plain data. A throw is recorded as `{ $error: '<error class>' }`, so an error that every dialect
raises agrees. Results are normalized before comparison: dates to ISO UTC strings, numeric strings to numbers,
bigints to strings, bytes to hex, object keys sorted.

## Divergences

`divergences.json` lists accepted differences: `{ "case", "target", "reason", "issue" }`. PGlite embeds a newer
PostgreSQL than the CI `postgres` target's 16.6, so a `postgres` divergence caused only by the version is listed with a
reason that starts `PGlite PostgreSQL version <v> vs CI 16.6:` (`<v>` is PGlite's `SHOW server_version`). `issue` is the
GitHub issue that tracks it; `"pending"` until it is opened. The test `every accepted divergence links an opened issue`
fails on a pending entry only with `ORM_CONFORMANCE_REQUIRE_ISSUES=1`, which the `conformance` job sets; a plain
`npm test` prints the pending count and passes. A listed divergence that agrees again fails everywhere: remove its entry.
