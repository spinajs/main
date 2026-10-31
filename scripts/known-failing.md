# Known-failing packages

Packages in `known-failing.json` may fail `scripts/test-all.mjs` and `scripts/coverage/run.mjs --ci` without failing the run; they print a warning. Recorded by `node scripts/test-all.mjs --ci` after `npm ci && npm run build`. Fix the package, then remove it from the list ( the runner says when a listed package passes ).

| Package | Symptom |
| --- | --- |
| internal-logger | 1 failing: logs before configuration is resolved are not written |
| templates | 1 failing: `cache should be the default mode` ( 2 compiles instead of 1 ) |
| templates-image | 6 passing, then the process does not exit |
| users | Suite does not finish within the runner timeout ( killed ) |

Observed on Windows under load; `http`, `reflection` and `authn-local` failed in some runs and passed in others, so they are not listed. Re-verify the "does not exit" entries on Linux CI.

Packages that never exit are given a short limit in `test-timeouts.json` so a hang costs minutes, not the 20 minute default. Do not paper over it with mocha `--exit`; the open handles are fixed by the test isolation work ( A6 ).
The per-package limits in `test-timeouts.json` are removed together with the package's known-failing entry.
