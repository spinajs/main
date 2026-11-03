# Cold-start benchmark

Measures time-to-listening of a synthetic SpinaJS HTTP app in manifest mode `off` (directory discovery) and `require` (`app.manifest.json`).

```bash
npm run build                      # the benchmark uses the built packages
node scripts/bench/cold-start.mjs  # N=200 controllers x M=5 routes, 5 runs per mode
node scripts/bench/cold-start.mjs --controllers 20 --routes 3 --runs 2 --out /tmp/bench.json
node scripts/bench/cold-start-gate.mjs   # the CI gate: every target of cold-start-targets.json
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--controllers` | 200 | Generated controllers (N) |
| `--routes` | 5 | `@Get` routes per controller (M) |
| `--runs` | 5 | Measured boots per mode |
| `--modes` | `off,require` | Manifest modes to measure |
| `--no-compile-cache` | cache on | Boots with `NODE_DISABLE_COMPILE_CACHE=1` |
| `--out` | `bench.json` | Result file |
| `--keep` | off | Keep the generated app (under `node_modules/.cache/`) for inspection |

## What it does

1. Generates the app in `node_modules/.cache/spinajs-cold-start-*` (inside the repo, so it resolves the workspace packages) and compiles it with `tsc`. Its own config, `lib/config/app.js`, sets `system.dirs.controllers`, the fs providers, a `BlackHoleTarget` logger at `info` and `http.port: 0`. `spinajs build` reads that config and writes `app.manifest.json`.
2. Lays the app out as an install does: `node_modules/` holds links to only the packages the manifest lists, and `package.json` gets `workspaces: []`, so the `off` config walk stops at the app instead of loading the config of every workspace package.
3. Boots `node boot.mjs` per sample with `SPINAJS_MANIFEST_MODE=off|require` (`SPINAJS_MANIFEST` for `require`). `boot.mjs` is the launcher [the http docs](../../docs/http/README.md#compile-cache) describe: it turns on the compile cache, imports `app.mjs` (bootstrappers, `Configuration`, `fsService`, `Intl`, `Controllers`, `HttpServer.start()`) and writes the cache once the app listens. Time-to-listening is the wall time from spawning the process to the listening line, so it includes Node start-up and module loading. After the line, an untimed request to the first and the last route checks that every controller loaded.
4. Runs one discarded warm-up boot per mode (it also fills the compile cache), then alternates the modes for `--runs` rounds so machine drift hits both. Prints the median and the min of each mode and writes all samples to `--out`.

The generated app, the child processes and the temp directory are removed on success, failure and SIGINT/SIGTERM.

## The CI gate

`cold-start-targets.json` holds the 4.x limits, and only there:

| Target | App | Mode | Median time-to-listening |
| --- | --- | --- | --- |
| framework floor | 1 controller x 5 routes | `require` | <= 450 ms |
| B10 | 200 controllers x 5 routes | `require` | <= 900 ms |

`cold-start-gate.mjs` measures each target with `runs` (30) boots per mode after the discarded warm-up, compile cache on, and compares the `require` median with `maxMedianMs`. A target over its limit is measured again, up to `reruns` (1) times, and fails only when every attempt is over: one rerun absorbs a noisy neighbour on a shared runner without moving the limit. The step summary lists every attempt, the limit and the runner's `node -e 0` median, which tells a slow runner from a slow framework. The job fails when a target fails. Each attempt's samples are written to `--out-dir` (`bench-<target>.json`, `bench-<target>-rerun1.json`) and uploaded as the `bench` artifact.

To try the gate against other limits, pass a file of the same shape: `node scripts/bench/cold-start-gate.mjs --targets my-targets.json --runs 5`. MOONSHOT tracks the 150 ms goal for 5.0.
