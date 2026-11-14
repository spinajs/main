---
"@spinajs/http": minor
---

Contract testing (`http.contractTesting`) runs once from the reply pipeline, after the last `onAfter`, instead of from the route response handler and the error handler. It now also checks the answers of server `onBefore` hooks, replies an `onAround` sends itself with `sendReply()`, and `@Idempotent` replays whose body an `onAfter` changed. Error-map replies and the global error answer are still checked as problem documents only. A guard armed for a reply that failed before `res.json` is re-armed by the next reply instead of being stacked, so a body is checked once.
