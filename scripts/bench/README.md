# Cold-start benchmark

Measures time-to-listening of a synthetic SpinaJS HTTP app in manifest mode `off` (directory discovery) and `require` (`app.manifest.json`).

```bash
npm run build                      # the benchmark uses the built packages
node scripts/bench/cold-start.mjs  # N=200 controllers x M=5 routes, 5 runs per mode
node scripts/bench/cold-start.mjs --controllers 20 --routes 3 --runs 2 --out /tmp/bench.json
node scripts/bench/cold-start-gate.mjs   # the CI gate: every target of cold-start-targets.json, warm and cold compile cache
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--controllers` | 200 | Generated controllers (N) |
| `--routes` | 5 | `@Get` routes per controller (M) |
| `--runs` | 5 | Measured boots per mode |
| `--modes` | `off,require` | Manifest modes to measure |
| `--caches` | `warm` | Compile cache states to measure: `warm` (filled by the warm-up boot), `cold` (an empty cache dir per boot, as on a first start), `off` (`NODE_DISABLE_COMPILE_CACHE=1`) |
| `--no-compile-cache` | | Same as `--caches off` |
| `--out` | `bench.json` | Result file |
| `--keep` | off | Keep the generated app (under `node_modules/.cache/`) for inspection |

## What it does

1. Generates the app in `node_modules/.cache/spinajs-cold-start-*` (inside the repo, so it resolves the workspace packages) and compiles it with `tsc`. Its own config, `lib/config/app.js`, sets `system.dirs.controllers`, the fs providers, a `BlackHoleTarget` logger at `info` and `http.port: 0`. `spinajs build` reads that config and writes `app.manifest.json`.
2. Lays the app out as an install does: `node_modules/` holds links to only the packages the manifest lists, and `package.json` gets `workspaces: []`, so the `off` config walk stops at the app instead of loading the config of every workspace package.
3. Boots `node boot.mjs` per sample with `SPINAJS_MANIFEST_MODE=off|require` (`SPINAJS_MANIFEST` for `require`). `boot.mjs` is the launcher [the http docs](../../docs/http/README.md#compile-cache) describe: it turns on the compile cache, imports `app.mjs` (bootstrappers, `Configuration`, `fsService`, `Intl`, `Controllers`, `HttpServer.start()`) and writes the cache once the app listens. Time-to-listening is the wall time from spawning the process to the listening line, so it includes Node start-up and module loading. After the line, an untimed request to the first and the last route checks that every controller loaded.
   The bench points `NODE_COMPILE_CACHE` at a dir inside the generated app, so it never touches the user's own cache dir: one dir for `warm`, a new empty one per boot for `cold`.
4. Runs one discarded warm-up boot per mode and cache state (it also fills the warm compile cache), then alternates them for `--runs` rounds so machine drift hits all of them. Prints the median and the min of each and writes all samples to `--out`.

The generated app, the child processes and the temp directory are removed on success, failure and SIGINT/SIGTERM.

## The CI gate

The `cold-start` workflow (`.github/workflows/cold-start.yml`) runs `cold-start-gate.mjs` on every pull request, on every push to master and to `v4`, and on `workflow_dispatch`. It is a workflow of its own, so the release job of `build.yml` never waits for it.

**The gate is report-only until the 4.x targets are met.** It prints the numbers and fails only when a target regresses against the baseline. A slow run against the 4.x limits does not block a merge or a release.

### Thresholds: `cold-start-targets.json`

Every threshold lives in this file, and only there:

| Key | Value | Meaning |
| --- | --- | --- |
| `targets[].maxMedianMs` | framework floor (1 controller x 5 routes, `require`): 450 ms; B10 (200 x 5, `require`): 900 ms | The 4.x limits on the warm-cache median time-to-listening |
| `enforceLimits` | `false` | `false`: a median over its limit is shown as "over (not enforced)" and does not fail the job. Set it to `true` once a perf branch meets the limits on CI; then a warm median over its limit fails too |
| `maxRegression` | `0.15` | A target fails when its warm or its cold median is more than 15% over the baseline |
| `runs` | 30 | Measured boots per compile cache state, after one discarded warm-up each |
| `reruns` | 1 | A failing target is measured again and fails only when every attempt fails: one rerun absorbs a noisy neighbour on a shared runner |

`scripts/__tests__/cold-start-gate.test.mjs` pins these values, so changing one is a visible, reviewed change.

### The baseline: `cold-start-baseline.json`

Per target, the warm and the cold median of one gate run on a GitHub runner (`warmMs`, `coldMs`), and `measuredOn` (run link, commit, date, CPU model, cores, Node, calibration time). The regression check uses only numbers measured on CI:

- While the file holds no CI numbers (`"measuredOn": null`, as committed now), the check is skipped and the step summary says so.
- Outside CI the check is skipped too, because a GitHub runner's numbers say nothing about another machine. `--baseline <file>` compares this machine with that file on purpose.

To measure a new baseline (first time, or after a change that moves the numbers on purpose), work on the branch whose baseline you update: `v4` for 4.x, which does not reach master for a long time.

1. Get a run of the workflow on that branch. Every push to `v4` (a merged pull request) runs it. `workflow_dispatch` (Actions > cold-start > Run workflow, or `gh workflow run cold-start.yml --ref v4`) works only once `cold-start.yml` is on the default branch, master: GitHub starts a dispatch only for a workflow it finds there.
2. When it is done, run `node scripts/bench/update-cold-start-baseline.mjs --latest` in a checkout of that branch. It takes the newest successful `push` or `workflow_dispatch` run on the current branch (`--branch <name>` picks another; on a detached HEAD it is `v4`), downloads its `cold-start` artifact with `gh`, refuses a candidate not measured on CI, and writes `cold-start-baseline.json`. `--run <run id>` takes that run instead, and only when it is a `workflow_dispatch` or `push` run of `cold-start.yml` on this repository's own code: a pull request run, from a fork above all, runs gate code its author controls. A downloaded `cold-start-baseline.candidate.json` can be passed as a file. A run after a change that slows a target on purpose fails its regression check, so `--latest` skips it: pass its id with `--run`.
3. Commit the file in a pull request into that branch.

### What a run reports

Per target, the gate measures `runs` boots with a warm and with a cold compile cache, alternating, and compares:

- the warm median with `maxMedianMs` (reported; enforced only with `enforceLimits`);
- the warm and the cold median with the baseline (`maxRegression`).

A row reads `pass` only when its target passed. A row of a failed target names what each attempt did with that compile cache, for example `**failed**: first run regressed, rerun ok` when the rerun failed by the other cache instead.

Before each attempt it records the runner: CPU model, cores, the `node -e 0` median of 30 starts and a calibration time (the median of a fixed CPU-bound JS workload). The step summary shows every attempt, the limit, the baseline and the change, and the runner of each attempt next to the baseline's, which tells a slower runner from a slower framework. GitHub runners land on different CPU generations, so compare the calibration times before reading a regression as the framework's. The calibration itself is noisy: on one machine it moved by about 40% between two targets measured two minutes apart, so it tells a much slower machine from a slower framework, not 10% from 15%. A target that is missing from the baseline (renamed or new) shows "no baseline" and goes unchecked until the next baseline.

Each attempt's samples, with the runner details, are written to `--out-dir` (`bench-<target>.json`, `bench-<target>-rerun1.json`), together with `cold-start-baseline.candidate.json`, and uploaded as the `cold-start` artifact. When the gate cannot run (for example the bench app does not build), the error goes to the step summary and the job fails.

To try the gate with other thresholds or another baseline: `node scripts/bench/cold-start-gate.mjs --targets my-targets.json --baseline my-baseline.json --runs 5`. MOONSHOT tracks the 150 ms goal for 5.0.
