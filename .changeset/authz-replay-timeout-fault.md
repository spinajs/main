---
"@spinajs/authz-ir": patch
---

`replayDecision` answers `timeout` only for the abort of its own `timeoutMs`; an error a contributor or a store raises after the deadline is rethrown instead of being reported as a timeout.
