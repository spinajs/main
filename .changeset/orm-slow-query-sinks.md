---
"@spinajs/orm": patch
---

Slow-query capture keeps running when a `SlowQuerySink` never settles: every sink receives a record at the same time, a sink that has not settled after `SLOW_QUERY_SINK_TIMEOUT_MS` (5 s) is logged as timed out, and the number of dropped slow statements is logged when the next capture ends. `LogSlowQuerySink` redacts the plan and writes only the class name of an EXPLAIN error, also with `db.Explain.CaptureBindings` on, so bound values never reach the application log; other sinks still receive what `CaptureBindings` allows. `sanitizeSql` replaces digit-separated (`1_000_000`), octal (`0o17`) and binary (`0b101`) number literals whole.
