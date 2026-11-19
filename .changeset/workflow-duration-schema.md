---
"@spinajs/workflow": patch
---

`workflow.retry.delay` and `workflow.retry.maxDelay` accept a number of milliseconds again. The configuration schema tried a plain string branch first, which turned `5000` into `'5000'`, and the engine then refused to start with "cannot parse duration". A string of digits is now read as milliseconds, and a value that is not a duration (`null`, a boolean, an empty string, a fraction of a millisecond, a negative number, text without a unit) is refused when the configuration loads.
