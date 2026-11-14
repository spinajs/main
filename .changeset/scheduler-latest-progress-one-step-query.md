---
"@spinajs/scheduler": patch
---

`LatestProgress.synthesize` no longer runs one `__scheduler_run_step` query per capped running run: it loads the steps of all those runs in one `whereIn(RunId)` query, ordered by `Seq`, and picks each run's current attempt from it. The events are the same, in the same order.
