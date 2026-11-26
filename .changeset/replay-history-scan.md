---
"@spinajs/replay": minor
---

`ReplayHistory` scans a history stream from the backward edge of a recording's window on, one entity at a time, through the port `ChangeReader` (`afterInstant`, `latest`, `coveredSince`), and throws `ReplayBudgetExceeded` past `maxChanges` or `maxKeys`. A pass that fails leaves every read of the history throwing until a later pass completes, and `load` throws `RangeError` for a limit that is not a finite number in its range. `@spinajs/replay/testing` exports `MemoryChangeReader`, a stream in memory for tests.
