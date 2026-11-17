---
'@spinajs/durable': minor
---

`RowLease.claimObserved()` claims from an epoch the caller already read, so a batch scan does not read each row twice. `claim()` delegates to it.
