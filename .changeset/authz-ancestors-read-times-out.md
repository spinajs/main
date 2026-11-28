---
"@spinajs/authz": patch
---

The per-ref `ancestors()` read of a check is bounded by `authz.engine.modelTimeoutMs`: a check, `can`, `assert` or `checkAll` that used to hang on an adapter whose `ancestors()` never settled now throws `ancestors of <type>:<id> timed out after <ms> ms`, like a failed read, and what the adapter answers later is dropped. A read slower than `modelTimeoutMs` (default 2000 ms) that used to succeed now fails the same way; raise `authz.engine.modelTimeoutMs` for an adapter that needs longer.
