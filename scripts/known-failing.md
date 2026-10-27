# Known-failing packages

Packages in `known-failing.json` may fail `scripts/test-all.mjs` and `scripts/coverage/run.mjs --ci` without failing the run; they print a warning. Recorded by `node scripts/test-all.mjs --ci` after `npm ci && npm run build`. Fix the package, then remove it from the list ( the runner says when a listed package passes ).

| Package | Symptom |
| --- | --- |
| authn | Never exits: killed by the runner timeout ( scripts/test-timeouts.json ) |
| authn-http | 541 passing, then the process does not exit ( killed ) |
| authz-http | 286 passing, 1 failing, and the process does not exit |
| authz-http-admin | 186 passing, then the process does not exit |
| authz-queue | 2 failing: `authz.admin.guard.privilegedPermission` required by the authz config schema |
| authz-testing | 705 passing, then the process does not exit |
| cli | 1 failing: `Should run command with arg and options` times out at 2000 ms |
| fs | 2 failing in `fs.temp.generic.test.ts` ( pre-existing on master ) |
| http-socket | 631 passing, 2 failing |
| internal-logger | 1 failing: logs before configuration is resolved are not written |
| log | 13 failing in `perf-sink.test.ts`: `LogMetricSink` collector is undefined |
| teams-http | 5 failing, e.g. `GET /teams` response mismatch |
| telemetry | 3 failing |
| templates | 1 failing: `cache should be the default mode` ( 2 compiles instead of 1 ) |
| templates-image | 6 passing, then the process does not exit |
| users | Suite does not finish within the runner timeout ( killed ) |

Observed on Windows under load; `http`, `reflection` and `authn-local` failed in some runs and passed in others, so they are not listed. Re-verify the "does not exit" entries on Linux CI.

Packages that never exit are given a short limit in `test-timeouts.json` so a hang costs minutes, not the 20 minute default. Do not paper over it with mocha `--exit`; the open handles are fixed by the test isolation work ( A6 ).
The per-package limits in `test-timeouts.json` are removed together with the package's known-failing entry.
