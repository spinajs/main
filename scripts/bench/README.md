# Cold-start benchmark

Measures time-to-listening of a synthetic SpinaJS HTTP app in manifest mode `off` (directory discovery) and `require` (`app.manifest.json`).

```bash
npm run build                      # the benchmark uses the built packages
node scripts/bench/cold-start.mjs  # N=200 controllers x M=5 routes, 5 runs per mode
node scripts/bench/cold-start.mjs --controllers 20 --routes 3 --runs 2 --out /tmp/bench.json
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--controllers` | 200 | Generated controllers (N) |
| `--routes` | 5 | `@Get` routes per controller (M) |
| `--runs` | 5 | Measured boots per mode |
| `--out` | `bench.json` | Result file |
| `--keep` | off | Keep the generated app (under `node_modules/.cache/`) for inspection |

## What it does

1. Generates the app in `node_modules/.cache/spinajs-cold-start-*` (inside the repo, so it resolves the workspace packages), compiles it with `tsc` and runs `spinajs build` to write `app.manifest.json`.
2. Boots `node boot.mjs` per sample with `SPINAJS_MANIFEST_MODE=off|require` (`SPINAJS_MANIFEST` for `require`). Time-to-listening is the wall time from spawning the process to the `HttpServer` printing its listening line, so it includes Node start-up and module loading. After the line, an untimed request to the first and the last route checks that every controller loaded.
3. Runs one discarded warm-up boot per mode, then alternates the modes for `--runs` rounds so machine drift hits both. Prints the median of each mode and writes all samples to `--out`.

The generated app, the child processes and the temp directory are removed on success, failure and SIGINT/SIGTERM.

In CI the `analysis` job runs it with the defaults, uploads `bench.json` and prints both medians in the step summary. There is no gate yet. MOONSHOT tracks a 150 ms target against these numbers.
