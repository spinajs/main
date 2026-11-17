---
"@spinajs/scheduler": patch
---

A `scheduler.*` duration written as a number of milliseconds works again: `scheduler.emitTimeout`, `scheduler.retention.runs`, `.logs`, `.errors`, and `every`, `jitter`, `misfireThreshold`, `timeout`, `retry.delay` and `retry.maxDelay` of a `scheduler.schedules` entry. The configuration schema used to turn the number into a string without a unit, which the scheduler then refused (`cannot parse duration '300000'`). A string of digits now counts as milliseconds. A value that is no duration (a string without a unit, a blank string, `null`, a boolean, a negative number, a fraction of a millisecond) is refused when the configuration is validated, with the key's path; before, it failed later, where the scheduler read it.
