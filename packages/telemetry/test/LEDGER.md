# Test ledger: @spinajs/telemetry

Every `it` of the 2.x suite of this package at `3d22b6c8f`, classified per
plan §1 rule 6 (F5). Classes: move, adapt, rewrite, drop (definitions:
`.authz-sdd/F5-task-7-brief.md`, kept in the header below).
Rewrite-class files go to `test/legacy-v2/` in their C/N lane; the T lane
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

## test/controller.metrics.test.ts

3 tests; dominant class adapt (rewrite 1, adapt 2).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 41 | GET /metrics > denies a request with no token | rewrite | C7 -> T4 | telemetry/test/v3/ (B23, B10): asserts the 2.x policy reason text "access token"; the 3.0 denial comes from `AccessPolicy` with `{ permission, resource, reason }` |
| 2 | 56 | GET /metrics > returns prometheus exposition text with the token | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`) |
| 3 | 68 | GET /metrics > exposes the http request metrics recorded by the middleware | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`) |

## test/controller.telemetry.test.ts

20 tests; dominant class adapt (rewrite 2, adapt 18).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 128 | telemetry json api > auth > rejects the guarded endpoints without a token | rewrite | C7 -> T4 | telemetry/test/v3/ (B23, B10): asserts the 2.x policy reason text "access token"; the 3.0 denial comes from `AccessPolicy` |
| 2 | 143 | telemetry json api > auth > rejects the guarded endpoints with a wrong token | rewrite | C7 -> T4 | telemetry/test/v3/ (B23): asserts "invalid access token" from the 2.x policy; a wrong token gives no service principal |
| 3 | 150 | telemetry json api > auth > leaves the probe endpoints open | adapt | C7 | telemetry/test/ (probes stay open: 200 without a token; the slot becomes a public config entry) |
| 4 | 157 | telemetry json api > GET /telemetry/stats > returns lifetime stats and the timeline | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 5 | 166 | telemetry json api > GET /telemetry/stats > computes the rates over the collection window | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 6 | 176 | telemetry json api > GET /telemetry/timeline > returns annotated buckets, not the raw snapshot map | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 7 | 194 | telemetry json api > GET /telemetry/timeline > returns the buckets in ascending key order | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 8 | 201 | telemetry json api > GET /telemetry/timeline > limits to the LAST n buckets when asked | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 9 | 221 | telemetry json api > GET /telemetry/timeline > rejects a bucket count that is not a positive integer | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 10 | 238 | telemetry json api > GET /telemetry/routes > returns a per-route breakdown | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 11 | 253 | telemetry json api > GET /telemetry/perf > returns aggregated spans and events | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 12 | 270 | telemetry json api > GET /telemetry/health > returns liveness info | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 13 | 282 | telemetry json api > GET /telemetry/health > runs no health checks | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 14 | 295 | telemetry json api > GET /telemetry/ready > returns 200 and the check list when everything is up | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 15 | 303 | telemetry json api > GET /telemetry/ready > returns 503 when a check is down | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 16 | 330 | telemetry json api > live traffic > the mounted middleware and the DI container share one TelemetryStore | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 17 | 338 | telemetry json api > live traffic > counts requests served by the server itself | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 18 | 346 | telemetry json api > live traffic > lists the route it just served, with that route own counter advanced | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 19 | 358 | telemetry json api > live traffic > returns the in-flight gauge to 0 once the response is done | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |
| 20 | 365 | telemetry json api > live traffic > advances the prometheus request counter for the route it served | adapt | C7 | telemetry/test/ (token header still sent; harness config `telemetry.auth.policies` to `telemetry.auth.permissions`; endpoint assertions unchanged) |

## test/openapi.test.ts

7 tests; dominant class adapt (adapt 7).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 124 | telemetry openapi document > documents every telemetry path | adapt | C7 | telemetry/test/ (document shape unchanged; no authz content) |
| 2 | 130 | telemetry openapi document > documents paths that are actually served | adapt | C7 | telemetry/test/ (document shape unchanged; no authz content) |
| 3 | 143 | telemetry openapi document > references a real component schema for each json response | adapt | C7 | telemetry/test/ (document shape unchanged; no authz content) |
| 4 | 167 | telemetry openapi document > documents the buckets query parameter | adapt | C7 | telemetry/test/ (document shape unchanged; no authz content) |
| 5 | 190 | telemetry openapi document > documents the 503 on readiness and the 403 on the guarded endpoints | adapt | C7 | telemetry/test/ (guarded paths still document a 403 `$ref` Forbidden, now derived from `ACCESS_DESCRIPTOR` or the policy slot; verify at C7) |
| 6 | 208 | telemetry openapi document > documents the 400 the timeline endpoint raises for a bad bucket count | adapt | C7 | telemetry/test/ (document shape unchanged; no authz content) |
| 7 | 216 | telemetry openapi document > leaves the unguarded probes free of a 403 | adapt | C7 | telemetry/test/ (public probes still document no 403) |

## test/policies.test.ts

7 tests; dominant class rewrite (rewrite 7).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 31 | TelemetryTokenPolicy > passes in development regardless of the token | rewrite | C7 -> T4 | telemetry/test/v3/ (B23, C7): the development skip stays but must be explicit |
| 2 | 36 | TelemetryTokenPolicy > rejects a request with no token | rewrite | C7 -> T4 | telemetry/test/v3/ (B23, B10): no token means an anonymous request; denial is 401 from `AccessPolicy`, not `Forbidden` thrown by the policy |
| 3 | 47 | TelemetryTokenPolicy > rejects a request with the wrong token | rewrite | C7 -> T4 | telemetry/test/v3/ (B23, B10): a wrong token yields no service principal (constant-time compare); denial comes from `AccessPolicy` |
| 4 | 58 | TelemetryTokenPolicy > accepts a request with the right token on the x-metrics-token header | rewrite | C7 -> T4 | telemetry/test/v3/ (B23, plan C7: `TelemetryAccessPolicy` reads `telemetry.auth.permissions.<endpoint>`; the token becomes `service:telemetry` via `ServicePrincipalSource`) |
| 5 | 63 | TelemetryTokenPolicy > is always enabled | rewrite | C7 -> T4 | telemetry/test/v3/ (B23): same check for `TelemetryAccessPolicy` (`isEnabled`) |
| 6 | 69 | PublicPolicy > always resolves | rewrite | C7 -> T4 | telemetry/test/v3/ (B23, B10): public probe slot; becomes a config slot with no permission, or `@AllowAnonymous` |
| 7 | 73 | PublicPolicy > is always enabled | rewrite | C7 -> T4 | telemetry/test/v3/ (B23): same check for the public slot |

## test/policy.registration.test.ts

3 tests; dominant class rewrite (rewrite 3).

| # | Line | Test | Class | Lane | Target |
|---|---|---|---|---|---|
| 1 | 25 | telemetry policy registration > registers both policies from the controller modules alone | rewrite | C7 -> T4 | telemetry/test/v3/ (B23): the fail-open guard is kept: a config-named policy that is not registered must never leave a route open; the replacement checks `TelemetryAccessPolicy` and the process-isolated probe |
| 2 | 30 | telemetry policy registration > resolves both policy names to a usable BasePolicy instance | rewrite | C7 -> T4 | telemetry/test/v3/ (B23): the fail-open guard is kept: a config-named policy that is not registered must never leave a route open; the replacement checks `TelemetryAccessPolicy` and the process-isolated probe |
| 3 | 44 | telemetry policy registration > registers both policies in a process that never loads the package barrel | rewrite | C7 -> T4 | telemetry/test/v3/ (B23): the fail-open guard is kept: a config-named policy that is not registered must never leave a route open; the replacement checks `TelemetryAccessPolicy` and the process-isolated probe |
