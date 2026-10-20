# authz bench: harness and 2.x baseline

## Run it

```
npm run bench --workspace=packages/authz-testing > out.txt 2>&1
npm run bench --workspace=packages/authz-testing -- --filter=orm --repeats=5 --scale=0.1
npm run bench --workspace=packages/authz-testing -- --files=02 --repeats=5
```

- Takes about 8 minutes at full scale. Close other heavy programs first.
- Prints a table; writes one `bench/out/<name>.json` per scenario (git-ignored) with every
  repeat plus the environment.
- `--filter=<substring>` picks scenarios by name; `--files=<substring>` picks scenario files
  and imports only those (a file that fails to import is reported as `skipped <file>: ...`
  and the run goes on, but the run exits non-zero if `--files` is given and a matched file fails); `--repeats=<n>` (default 3), `--scale=<x>` scales iterations and
  warm-up (use 0.05 to 0.2 for smoke runs only).

The bench lives outside `src/`, so it is not compiled into `lib/`, not published, and not part
of `npm run test`. It imports the 2.x sources of `@spinajs/users` by relative path
(`../../../users/src/...`); `@spinajs/users` is not a dependency of authz-testing (no `users*`
dependency in `authz*` packages) and X1's 3.0 scenarios must not import it. The 2.x scenarios
also import `accesscontrol`, `@spinajs/orm`, `@spinajs/orm-sqlite` and
`@spinajs/configuration`, which authz-testing does not declare; they resolve through workspace
hoisting. `bench/tsconfig.json` is for editors and `tsc -p bench/tsconfig.json --noEmit`;
`npm run bench` type-checks through the package's own `tsconfig.json`.

## Add a scenario (X1: the 3.0 side)

Drop `bench/scenarios/<nn>-<name>.ts` that default-exports a `Scenario` or an array of them
(`bench/lib.ts`). Files run in name order; names starting with `_` are skipped. Nothing in the
runner changes.

```ts
import type { Scenario } from '../lib.js';
export default {
  name: 'check.warm',             // output file name; keep the area.what convention
  compare: 'probeGrant.warm',     // optional: table prints ratio against that scenario
  iterations: 200_000, warmup: 20_000,
  setup: async () => { /* build the engine, fixtures */ },
  verify: () => { /* throw if run() does not return what this scenario claims to time */ },
  run: () => engine.check(...),   // sync or async; timed per call
} satisfies Scenario;
```

Every scenario should define `verify()`: it runs once after `setup` and throws when `run` is
not doing the work the name claims (a deny instead of a grant, a wrong row count, a missing
WHERE). Set `batch` for operations under about 1 us so the 100 ns timer tick does not dominate.

All scenario files share one process and the global DI. `02-orm-select.ts` registers the 2.x
`RbacModelPermissionMiddleware` as a query middleware for the whole process and calls
`DI.clearCache()` in its boot. Run a 3.0 ORM scenario with `--files=<its file>` so it never
runs under the 2.x middleware.

Scenario ids to compare against for release gate item 7:

| 3.0 measurement | 2.x reference scenario |
|---|---|
| warm `check` p99 <= 2 x probeGrant p99 | `probeGrant.depth3`; `probeGrant.warm` only if 3.0 `check` resolves attribute lists (see "Which row is the gate reference") |
| `checkMany(30)` warm <= 1 ms | absolute; no 2.x equivalent |
| ORM select overhead <= 10 % | `orm.build.*`, `orm.list.*`, `orm.point.*`; two readings, see "ORM gate readings" |
| canvas `file:read` list over 1,000 files <= 2 x plain EXISTS | not 2.x; needs its own Postgres scenario |
| session restore, token validation <= 1 ms warm | absolute |

## How X1 reruns this

R1 deletes the 2.x authorization code and `accesscontrol`, so the two 2.x scenario files
cannot import in the X1 tree (the runner skips them with a message instead of failing). Do not
copy 3.0 scenarios into the 2.x tree or the reverse; compare JSON only.

1. `git worktree add ../spinajs-2x 860db78f670b9761d9341e04461aa233af7f93a8`, `npm ci`, build
   (`node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json`). The bench files were
   uncommitted at that SHA: in that worktree, check out the F5 commit that adds `bench/` (see
   `git log -- packages/authz-testing/bench`) and restore `packages/users/src` from the SHA.
   Do not copy `bench/` from the X1 tree: it would bring X1's 3.0 scenarios along.
2. On the same machine, with heavy programs closed, run the 2.x rows there
   (`npm run bench --workspace=packages/authz-testing -- --repeats=5`), then the 3.0 rows in
   the X1 tree (`--files=<3.0 file> --repeats=5`), alternating if the machine is noisy.
3. Compare the JSON in each tree's `bench/out/`. The committed `bench/baseline/2x/*.json`
   (3 repeats, the run below) is the fallback when the worktree cannot be rebuilt.

## Method

- Each scenario: one setup, `verify()`, `warmup` unmeasured calls, then `repeats` (3) measured
  runs of `iterations` calls. Every call is timed with `process.hrtime.bigint()`.
- Per repeat: p50, p95, p99 (nearest rank), mean, ops/s. Headline numbers are the **median
  over the 3 repeats**; p99 is the median of the three p99s.
- Timer resolution: on Windows `hrtime` ticks at 100 ns, so every unbatched number is a
  multiple of 0.1 us and carries about 100 ns of timer cost. `effectiveRoles` runs with
  `batch: 10` (sample = 10 calls / 10); its figures are batch means at 10 ns resolution, not
  per-call percentiles. The gate rows (>= 2 us) are unbatched.
- Probe scenarios: 200,000 iterations, 20,000 warm-up (unknown-role: 50,000 / 5,000), same
  arguments every call. ORM build-only: 50,000 / 5,000. ORM list: 4,000 / 500; point:
  10,000 / 1,000. **ORM list p99 rests on 40 tail samples per repeat (point: 100), so the
  ORM p99 columns are coarse; the ORM ratios use p50 and mean.**
- Logger: `*` at level `info` to a black-hole target, so the trace calls in the 2.x
  middleware hit the level gate as in production and cost almost nothing.
- ORM model: SQLite in-memory, table `bench_doc` (Id, UserId, Value), 1,000 rows, owners
  1..10 with 100 rows each. `read:own` user is owner 1, `read:any` user is user 2. List =
  `where Id > 0 take 50`; point = `where Id = 11` first (row 11 belongs to owner 1, so every
  context returns the same row). `verify()` checks this: the build SQL carries the `UserId`
  predicate only for `read-own`; list returns 50 rows in every context (only owner 1 rows for
  `read-own`); point returns row 11.
- ORM contexts per family: `nostore` (no ALS store, no `store.run`; the middleware returns at
  its first check), `nouser` (`store.run({})`; the middleware returns at `!User`; the
  baseline that includes the ALS cost), `skip` (`SkipModelPermissionCheck`: the middleware
  enters and applies nothing), `read-any`, `read-own`. The table's ratio column compares
  `skip`, `read-any`, `read-own` with `nouser`, and `nouser` with `nostore`. `build` rows only
  compile the query (`toDB()`), which isolates the middleware's own cost from SQL execution
  and hydration.
- Grants for the probe scenarios: roles viewer, editor ($extend viewer), manager (extend
  editor), admin (extend manager), auditor; 20 resources with `:any` and `:own` actions.
  Depth ladders (`lad`, `fstar`, `fneg`, `fempty`; 4 levels each) use one resource and one
  action (`readOwn`).

## Machine

- CPU: 12th Gen Intel Core i7-12700KF (20 logical cores), Windows 11 (10.0.26200), Node
  v24.14.1, run from Git Bash on the dev workstation.
- Date: 2026-10-02 (rerun after the review fixes).
- Git SHA measured: `860db78f670b9761d9341e04461aa233af7f93a8` (branch `authz/F5-testkit`).
  `packages/users` reads `3.0.0-alpha.0` but its authorization code is the 2.0.546-era code
  moved by F0b, unchanged in behaviour; that is the "2.0.546" baseline here. The 2.x code
  (`packages/users/src`) is unchanged since the first run.
- **Not idle**: about 35 node processes (other agents running tests and builds) were alive
  when this run started. Treat differences under about 15 % as noise; the three-repeat spread
  is in `baseline/2x/*.json`.

## Numbers (microseconds, median of 3 repeats)

| scenario | p50 | p95 | p99 | mean | ops/s |
|---|---:|---:|---:|---:|---:|
| probeGrant.warm (admin, 3-level; lists `[]`, `['*','!secret']`, `[]`) | 13.5 | 27.8 | **56.7** | 16.9 | 59,155 |
| probeGrant.warm.shallow (editor, 1-level) | 1.00 | 2.20 | 3.10 | 1.36 | 733,249 |
| probeGrant.warm.multi-role (2 roles) | 1.20 | 2.60 | 3.60 | 1.66 | 602,060 |
| probeGrant.warm.deny | 0.80 | 1.60 | 2.20 | 1.00 | 998,046 |
| probeGrant.unknown-role (throws inside, caught) | 14.7 | 27.5 | 53.6 | 17.3 | 57,741 |
| probeGrant.depth0 | 0.80 | 1.00 | 1.70 | 0.86 | 1,168,857 |
| probeGrant.depth1 | 0.90 | 1.70 | 2.50 | 1.11 | 899,095 |
| probeGrant.depth2 | 1.10 | 1.70 | 2.30 | 1.22 | 819,296 |
| probeGrant.depth3 | 1.20 | 1.80 | **2.70** | 1.42 | 706,434 |
| probeGrant.depth3.fold-star | 1.50 | 2.70 | 3.70 | 1.80 | 557,073 |
| probeGrant.depth3.fold-negated | 49.6 | 94.1 | 159.2 | 56.6 | 17,664 |
| probeGrant.depth3.fold-empty | 6.00 | 11.4 | 21.1 | 7.25 | 137,941 |
| effectiveRoles (batch 10) | 0.01 | 0.02 | 0.02 | 0.01 | 103,543,786 |
| authorize.2x-query-decision (effectiveRoles + 2 probes) | 2.50 | 4.70 | 6.90 | 3.11 | 321,218 |
| orm.build.nostore | 93.2 | 203.1 | 345.8 | 112.3 | 8,907 |
| orm.build.nouser | 97.4 | 218.8 | 349.2 | 117.8 | 8,488 |
| orm.build.skip | 98.1 | 221.7 | 361.1 | 119.0 | 8,404 |
| orm.build.read-any | 107.2 | 241.0 | 382.6 | 128.7 | 7,768 |
| orm.build.read-own | 131.9 | 300.8 | 454.4 | 160.1 | 6,246 |
| orm.list.nostore | 3945.2 | 6633.9 | 8737.9 | 4329.5 | 231 |
| orm.list.nouser | 4299.8 | 7151.8 | 8866.0 | 4708.1 | 212 |
| orm.list.skip | 3882.2 | 5842.8 | 7328.5 | 4127.8 | 242 |
| orm.list.read-any | 3867.3 | 5596.4 | 7397.5 | 4078.8 | 245 |
| orm.list.read-own | 4072.6 | 6272.8 | 7809.5 | 4366.1 | 229 |
| orm.point.nostore | 303.2 | 494.7 | 692.7 | 324.6 | 3,080 |
| orm.point.nouser | 332.4 | 561.9 | 754.5 | 363.1 | 2,754 |
| orm.point.skip | 342.5 | 605.4 | 851.6 | 380.8 | 2,626 |
| orm.point.read-any | 331.5 | 524.1 | 753.0 | 354.7 | 2,819 |
| orm.point.read-own | 364.3 | 573.6 | 792.7 | 389.4 | 2,568 |

Per-repeat p99 (us) for the gate candidates: probeGrant.warm 57.9 / 46.4 / 56.7;
probeGrant.depth3 2.3 / 2.7 / 3.7; depth0 1.9 / 1.5 / 1.7; depth3.fold-negated
156.8 / 159.2 / 173.7; shallow 3.1 / 3.0 / 3.6; multi-role 3.6 / 3.3 / 4.5. Full per-repeat
data for every row is committed in `bench/baseline/2x/*.json` (`bench/out/` is git-ignored and
overwritten by every run).

ORM ratios, p50 / mean:

| | read-any vs `nouser` | read-own vs `nouser` | read-any vs `nostore` | read-own vs `nostore` |
|---|---:|---:|---:|---:|
| build | 1.10 / 1.09 | 1.35 / 1.36 | 1.15 / 1.15 | 1.42 / 1.43 |
| list | 0.90 / 0.87 | 0.95 / 0.93 | 0.98 / 0.94 | 1.03 / 1.01 |
| point | 1.00 / 0.98 | 1.10 / 1.07 | 1.09 / 1.09 | 1.20 / 1.20 |

`nouser` costs 1.05x over `nostore` on build: that is ALS `store.run` and its propagation, not
authorization (the per-repeat p50 is tight, about +4 us each repeat). The list (1.09x) and point
(1.10x) figures are noise: on both, `skip` and `read-any` land below `nostore`.

## Which row is the gate reference

Gate item 7: warm `check` p99 <= 2 x the 2.x `probeGrant` p99. The first run blamed `$extend`
depth for a 10x gap between two rows. The controlled ladder shows otherwise: with one
resource, one action and one attribute list, depth 0 to 3 costs 0.8 to 1.2 us p50 (p99 1.7 to
2.7 us). The cost comes from the attribute fold in accesscontrol's `getUnionAttrsOfRoles`:
when several roles in the hierarchy hold the resource, their attribute lists are unioned
through `Notation.Glob.union`, and a negated glob (`'!secret'`) makes that union expensive.
Depth 3 with `['*','!secret']` at every level costs 49.6 us p50; with `[]` contributions
6.0 us; with plain `['*']` 1.5 us. `probeGrant.warm` (13.5 us p50, p99 about 57) is this fold,
not depth.

- **Reference: `probeGrant.depth3`** (p99 2.7 us in this run). The threshold is 2 x the depth3
  p99 from a 2.x rerun in the same session as the 3.0 run (median of 5 repeats); depth3 p99
  moves with the session (2.3 to 3.7 us across repeats, 6.4 us in one rerun), so 5.4 us is
  only this run's value. It holds
  action, resource and attribute shape fixed and has the deepest chain in the model, so it
  prices the hierarchy walk and nothing else. Run the 3.0 `check` on the same role chain
  (4 roles, 3 `$extend` levels) on one resource. A 3.0 `check` that answers a decision, not
  an attribute list, never pays the fold, so comparing it with a fold row would loosen the
  gate without a reason.
- **Alternative: `probeGrant.warm`** (p99 about 57 us in this run; the same 2 x rule applies).
  It is the one realistic mixed-grants role, but most of its cost is the negated-glob union.
  Use it only if the 3.0 `check` also resolves attribute lists, and say so in the X1 record.

Either way X1 states which row it used and runs 3.0 on the same shape.

## ORM gate readings

"ORM select overhead <= 10 %" has two readings; X1 states which it applies.

- **A: 3.0 with authz vs no authz <= 10 %.** The 2.x middleware itself does not meet this on
  query construction (`build`: 1.15x read-any, 1.42x read-own vs `nostore`; 1.10x and 1.35x
  vs `nouser`). On list and point selects it is inside the noise (0.9x to 1.2x), because
  execution and hydration (about 70 us per row) dominate.
- **B: 3.0 vs the 2.x middleware <= 10 %.** Compare the 3.0 rows with the 2.x rows above from
  the same session; the 2.x rows are the reference, not `nostore`.

The `build` rows are the only ones that resolve a 10 % difference on this machine.

## Notes and caveats

- **Unknown role** is expensive in 2.x (about 15 us p50): accesscontrol throws and
  `probeGrant` catches. A 3.0 `check` for an unknown role has no throw to pay.
- **ORM end-to-end rows are noisy.** Run-to-run spread is about +/-15 % with other agents
  active (`orm.list.skip` and `read-any` landed below `nostore`). Use `--repeats=5`, the same
  machine and session, and trust `build` and p50 over p99.
- `orm.*.skip` is "middleware entered, no grant work": it reads the flag and returns. With the
  logger at `info` it no longer pays a trace entry. The first run, at `trace`, measured +6.5 us
  p50 for `build.skip` over `nostore`; like for like it is now +4.9 us over `nostore` (so trace
  logging cost about 1.6 us), and +0.7 us over `nouser`.
- `orm.list.read-own` returns 50 of the 100 owned rows; the others return 50 of 1,000. Every
  context hydrates 50 rows.
- JIT and GC state differ per process; do not compare numbers taken on a different machine
  or Node version.
