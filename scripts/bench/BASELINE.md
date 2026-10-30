# Cold-start baseline

Recorded with `node scripts/bench/cold-start.mjs` (N=200 controllers, M=5 routes, 5 runs per mode, plus one discarded warm-up per mode). The full run took about 1m48s, so nothing was reduced.

| | |
| --- | --- |
| Date | 2026-10-30 |
| Machine | Intel Core i9-14900K (32 threads), 96 GB, Windows 11 (10.0.26200), Node v24.14.1 |
| Base | `d7cb745a1` + this branch |

| manifest mode | median time-to-listening | samples (ms) |
| --- | --- | --- |
| off | 2144.4 ms | 1832.1, 2144.4, 1843.6, 2234.7, 2269.4 |
| require | 1921.2 ms | 1915.4, 1921.2, 1802.2, 2678.4, 2101.4 |

Caveats:

- The machine was loaded by parallel builds of sibling v4 branches while this ran. Samples spread by about 25%, so the 10% gap between the medians is within the noise of a single run; treat these as an order of magnitude and compare on a quiet machine or in CI.
- Time-to-listening is wall time from process spawn, so it includes Node start-up and loading `@spinajs/*` in both modes.
- The 150 ms MOONSHOT target is far from both numbers. The comparison to watch is `require` vs `off` on the same run.
