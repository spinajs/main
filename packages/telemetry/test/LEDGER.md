# Test ledger: @spinajs/telemetry

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the header below).
Rewrite-class files went to `test/legacy-v2/` in their C/N lane; the T lane
replaces them and deletes the legacy file.

- **move**: the test's code and assertions stay as they are; only the file moves to another package because the code under test moves there.
- **adapt**: the test stays (in this package, or in the package the code moves to) with mechanical edits that keep its intent and its expected values.
- **rewrite**: the test asserts 2.x authorization API or behaviour that 3.0 replaces, or 2.x authentication behaviour that an N lane redesigns; the owning lane moves the file to `test/legacy-v2/` and a T (or N) lane writes the 3.0 replacement, named in the Target column with the rule ids.
- **drop**: no 3.0 counterpart; the reason is in the Target column.

| Class | Count |
|---|---|
| move | 0 |
| adapt | 27 |
| rewrite | 13 |
| drop | 0 |
| **total** | 40 |

Scope: only the files below touch authorization; the other test files of
this package are unchanged by the authz v3 plan and not ledgered.

Final places (C7): adapt rows stay in the named `test/*.test.ts` file; rewrite
rows were replaced by T4 in the named `test/*.test.ts` file (`test/legacy-v2/` removed,
the replacements stay in `test/`, not `test/v3/`). The Target column gives the
file and test name.

Unledgered files (`it` count from the TSV):

- `test/dto.test.ts`: 3
- `test/endpoints.test.ts`: 2
- `test/health.test.ts`: 12
- `test/inMemoryPerfSink.test.ts`: 8
- `test/metrics.test.ts`: 7
- `test/middleware.test.ts`: 15
- `test/perf-sink.test.ts`: 3
- `test/requestStats.test.ts`: 7
- `test/routeStats.test.ts`: 5
- `test/store.test.ts`: 6
- `test/timeline.test.ts`: 4

Ledgered 40, unledgered 72, package total 112.

Added by C7 (`it` count; the suite runs 164 specs: 72 unledgered, 27 adapt, 65 added):
T4 added 3 specs (`test/policy-registration.test.ts`); the suite now runs 167.

- `test/access-policy.test.ts`: 29
- `test/behaviour.test.ts`: 2 (B23.configNamed, strict)
- `test/contributor.test.ts`: 6
- `test/service-token.test.ts`: 18
- `test/token-policy.test.ts`: 9
- `test/openapi.test.ts`: 1 (the 401 on guarded paths; the file holds 7 adapt rows and this one)

## test/controller.metrics.test.ts

3 tests; dominant class adapt (rewrite 1, adapt 2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 41 | GET /metrics > denies a request with no token | rewrite | T4: closed | `test/service-token.test.ts`: "answers 401 without credentials" (every GUARDED endpoint, metrics included). The 2.x reason text "access token" becomes the body `{ error: 'unauthenticated' }` from AccessPolicy (B10, B23) |
| 2 | 56 | GET /metrics > returns prometheus exposition text with the token | adapt | C7 | `test/controller.metrics.test.ts`: "returns prometheus exposition text with the token" |
| 3 | 68 | GET /metrics > exposes the http request metrics recorded by the middleware | adapt | C7 | `test/controller.metrics.test.ts`: "exposes the http request metrics recorded by the middleware" |

## test/controller.telemetry.test.ts

20 tests; dominant class adapt (rewrite 2, adapt 18).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 128 | telemetry json api > auth > rejects the guarded endpoints without a token | rewrite | T4: closed | `test/service-token.test.ts`: "answers 401 without credentials". Reason text becomes `{ error: 'unauthenticated' }` (B10, B23) |
| 2 | 143 | telemetry json api > auth > rejects the guarded endpoints with a wrong token | rewrite | T4: closed | `test/service-token.test.ts`: "answers 401 for a wrong token of the same length or another length, on either header". "invalid access token" text becomes 401 `unauthenticated`; a wrong token gives no service principal (B10, B23) |
| 3 | 150 | telemetry json api > auth > leaves the probe endpoints open | adapt | C7 | `test/controller.telemetry.test.ts`: "leaves the probe endpoints open" |
| 4 | 157 | telemetry json api > GET /telemetry/stats > returns lifetime stats and the timeline | adapt | C7 | `test/controller.telemetry.test.ts`: "returns lifetime stats and the timeline" |
| 5 | 166 | telemetry json api > GET /telemetry/stats > computes the rates over the collection window | adapt | C7 | `test/controller.telemetry.test.ts`: "computes the rates over the collection window" |
| 6 | 176 | telemetry json api > GET /telemetry/timeline > returns annotated buckets, not the raw snapshot map | adapt | C7 | `test/controller.telemetry.test.ts`: "returns annotated buckets, not the raw snapshot map" |
| 7 | 194 | telemetry json api > GET /telemetry/timeline > returns the buckets in ascending key order | adapt | C7 | `test/controller.telemetry.test.ts`: "returns the buckets in ascending key order" |
| 8 | 201 | telemetry json api > GET /telemetry/timeline > limits to the LAST n buckets when asked | adapt | C7 | `test/controller.telemetry.test.ts`: "limits to the LAST n buckets when asked" |
| 9 | 221 | telemetry json api > GET /telemetry/timeline > rejects a bucket count that is not a positive integer | adapt | C7 | `test/controller.telemetry.test.ts`: "rejects a bucket count that is not a positive integer" |
| 10 | 238 | telemetry json api > GET /telemetry/routes > returns a per-route breakdown | adapt | C7 | `test/controller.telemetry.test.ts`: "returns a per-route breakdown" |
| 11 | 253 | telemetry json api > GET /telemetry/perf > returns aggregated spans and events | adapt | C7 | `test/controller.telemetry.test.ts`: "returns aggregated spans and events" |
| 12 | 270 | telemetry json api > GET /telemetry/health > returns liveness info | adapt | C7 | `test/controller.telemetry.test.ts`: "returns liveness info" |
| 13 | 282 | telemetry json api > GET /telemetry/health > runs no health checks | adapt | C7 | `test/controller.telemetry.test.ts`: "runs no health checks" |
| 14 | 295 | telemetry json api > GET /telemetry/ready > returns 200 and the check list when everything is up | adapt | C7 | `test/controller.telemetry.test.ts`: "returns 200 and the check list when everything is up" |
| 15 | 303 | telemetry json api > GET /telemetry/ready > returns 503 when a check is down | adapt | C7 | `test/controller.telemetry.test.ts`: "returns 503 when a check is down" |
| 16 | 330 | telemetry json api > live traffic > the mounted middleware and the DI container share one TelemetryStore | adapt | C7 | `test/controller.telemetry.test.ts`: "the mounted middleware and the DI container share one TelemetryStore" |
| 17 | 338 | telemetry json api > live traffic > counts requests served by the server itself | adapt | C7 | `test/controller.telemetry.test.ts`: "counts requests served by the server itself" |
| 18 | 346 | telemetry json api > live traffic > lists the route it just served, with that route own counter advanced | adapt | C7 | `test/controller.telemetry.test.ts`: "lists the route it just served, with that route own counter advanced" |
| 19 | 358 | telemetry json api > live traffic > returns the in-flight gauge to 0 once the response is done | adapt | C7 | `test/controller.telemetry.test.ts`: "returns the in-flight gauge to 0 once the response is done" |
| 20 | 365 | telemetry json api > live traffic > advances the prometheus request counter for the route it served | adapt | C7 | `test/controller.telemetry.test.ts`: "advances the prometheus request counter for the route it served" |

## test/openapi.test.ts

7 tests; dominant class adapt (adapt 7).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 124 | telemetry openapi document > documents every telemetry path | adapt | C7 | `test/openapi.test.ts`: "documents every telemetry path" |
| 2 | 130 | telemetry openapi document > documents paths that are actually served | adapt | C7 | `test/openapi.test.ts`: "documents paths that are actually served" |
| 3 | 143 | telemetry openapi document > references a real component schema for each json response | adapt | C7 | `test/openapi.test.ts`: "references a real component schema for each json response" |
| 4 | 167 | telemetry openapi document > documents the buckets query parameter | adapt | C7 | `test/openapi.test.ts`: "documents the buckets query parameter" |
| 5 | 190 | telemetry openapi document > documents the 503 on readiness and the 403 on the guarded endpoints | adapt | C7 | `test/openapi.test.ts`: "documents the 503 on readiness and the 403 on the guarded endpoints" |
| 6 | 208 | telemetry openapi document > documents the 400 the timeline endpoint raises for a bad bucket count | adapt | C7 | `test/openapi.test.ts`: "documents the 400 the timeline endpoint raises for a bad bucket count" |
| 7 | 216 | telemetry openapi document > leaves the unguarded probes free of a 403 | adapt | C7 | `test/openapi.test.ts`: "leaves the unguarded probes free of a 403" |

## test/policies.test.ts

7 tests; dominant class rewrite (rewrite 7).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 31 | TelemetryTokenPolicy > passes in development regardless of the token | rewrite | T4: closed | `test/access-policy.test.ts`: "development skip" block ("flag on, APP_ENV=development: skipped", "flag off, development env: checked") and `test/token-policy.test.ts`: "does not skip the check in development without the opt-in flag". The skip needs the explicit `telemetry.auth.skipInDevelopment` flag (C7 decision, B23) |
| 2 | 36 | TelemetryTokenPolicy > rejects a request with no token | rewrite | T4: closed | `test/access-policy.test.ts`: "an 'AccessPolicy' slot > answers an anonymous request 401" and `test/service-token.test.ts`: "answers 401 without credentials". The denial is 401 from AccessPolicy, not a Forbidden thrown by the policy (B10) |
| 3 | 47 | TelemetryTokenPolicy > rejects a request with the wrong token | rewrite | T4: closed | `test/service-token.test.ts`: "answers 401 for a wrong token of the same length or another length, on either header" and `test/token-policy.test.ts`: "refuses a wrong token of the same length" (deprecated policy kept). Constant-time compare lives in the token source (B10) |
| 4 | 58 | TelemetryTokenPolicy > accepts a request with the right token on the x-metrics-token header | rewrite | T4: closed | `test/service-token.test.ts`: "answers 200 for the token on x-metrics-token" (token becomes `service:telemetry`) and `test/token-policy.test.ts`: "accepts the right token on x-metrics-token" |
| 5 | 63 | TelemetryTokenPolicy > is always enabled | rewrite | T4: closed | `test/access-policy.test.ts`: "a slot naming a BasePolicy > delegates isEnabled to it"; an 'AccessPolicy' slot is always enabled by `TelemetryAccessPolicy.isEnabled` (same test, `refused` slot) |
| 6 | 69 | PublicPolicy > always resolves | rewrite | T4: closed | `test/access-policy.test.ts`: "a slot naming a BasePolicy > delegates to it: PublicPolicy lets an anonymous request through"; the probes stay open in `test/service-token.test.ts`: "leaves the probes open without credentials" |
| 7 | 73 | PublicPolicy > is always enabled | rewrite | T4: closed | `test/access-policy.test.ts`: "delegates isEnabled to it" (a named slot defers to the named policy's `isEnabled`; PublicPolicy is the always-enabled case, B23) |

## test/policy.registration.test.ts

3 tests; dominant class rewrite (rewrite 3).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 25 | telemetry policy registration > registers both policies from the controller modules alone | rewrite | T4: closed | `test/policy-registration.test.ts`: "registers the named policies and the contributor from the controller modules alone". Fail-closed guard kept; `TelemetryAccessPolicy` is a class-level decorator, not a name, so the named policies are `PublicPolicy` and the deprecated `TelemetryTokenPolicy`, plus `TelemetryAccessContributor` (C7 hand-off) |
| 2 | 30 | telemetry policy registration > resolves both policy names to a usable BasePolicy instance | rewrite | T4: closed | `test/policy-registration.test.ts`: "resolves the named policies to a BasePolicy instance" |
| 3 | 44 | telemetry policy registration > registers both policies in a process that never loads the package barrel | rewrite | T4: closed | `test/policy-registration.test.ts`: "registers them in a process that never loads the package barrel" (probe in `test/support/probe.policy-registration.ts`; with the controller imports removed the probe fails, checked by hand) |
