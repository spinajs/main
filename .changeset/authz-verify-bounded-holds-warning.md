---
"@spinajs/authz-verify": patch
"@spinajs/cli": patch
---

Every `isolated` assertion that holds, and every `never`, `onlyVia`, `implies` or `separated` that only the bounded engine answered `holds`, now prints the warning `AZV007` instead of the info `AZV002`: `warn AZV007 never(role:other, tenant:enter)  holds only up to k=2 (not proven)` in place of `ok   AZV002 never(role:other, tenant:enter)  verified up to k=2`. Such an answer means no counterexample with at most k objects per type, not a proof. The default exit code does not change (`--fail-on error` passes it), but a pipeline that runs `spinajs authz:verify --fail-on warning` now fails on every bounded holds; switch it to `--fail-on error` to keep today's gate. The new `--fail-on bounded` fails on an error or an `AZV007` line, and not on other warnings (`AZV003`, `AZV090`), for a gate that passes only on proofs. A holds of the exact engine stays `AZV002` (`holds (exact)`). The `json` and `github` outputs carry `AZV007` with severity `warning`, in the shape of every other diagnostic; the `json` summary keeps its fields and counts it under `warning`.
