---
"@spinajs/replay": minor
---

`ReplayHistory` scans a history stream from the backward edge of a recording's window on, one entity at a time, through the port `ChangeReader` (`afterInstant`, `latest`, `coveredSince`), and throws `ReplayBudgetExceeded` past `maxChanges` or `maxKeys`. `@spinajs/replay/testing` exports `MemoryChangeReader`, a stream in memory for tests.
