---
"@spinajs/scheduler": minor
"@spinajs/tracing": minor
---

Each run attempt executes under a root span `run <schedule>` with `step <name>` children; a step served from the resume map is marked `spina.scheduler.replayed`. The attempt's traceparent is stored in the new `__scheduler_run_attempt.TraceParent` column (migration `Scheduler_2026_11_16_00_00_00`), and a retry or a resumed run links to the attempt it continues (`spina.scheduler.resumed`). `SpinaAttr` gains `Attempt`, `Trigger` and `Replayed`.
