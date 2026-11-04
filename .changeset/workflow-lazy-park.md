---
"@spinajs/workflow": minor
---

A sleep that is not due and a wait without an event no longer suspend the whole run: the activation parks only once every durable operation in flight is parked, so `Promise.race` over `ctx.sleep()` / `ctx.waitForEvent()` and fan-outs whose branches each sleep work as written. Parallel parks merge into one wake-up: waiting wins, the earliest wake time applies, and waits for different names park with `WaitingFor = '*'`, which `signal()` and the engine's signalled-wait scan wake only for a name with a pending wait. A wait that loses a race stays pending and consumes events of its name on later replays.
