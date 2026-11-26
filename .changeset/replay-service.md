---
"@spinajs/replay": minor
---

`DomainReplayService` implements `ReplayService`: it loads a recording from the `RecordingSource` of its domain, replays it with the domain's `Replayer` over the `StateView` of the registered `StateSource`, and applies the verdict rules (`verdictOf`). Limits come from the new configuration section `replay.*` with per-domain overrides `replay.domains.<domain>.*` (`replayLimits`); every key has a ceiling, so a value the history or the timer would refuse fails the boot. A replay past a domain's `concurrency` throws `ReplayBusy`, a source throws `RecordingUnreadable` for a recording it cannot read back, a read of the state that failed decides the replay even when the replayer answers anyway, and `ReplayService.replay` takes `maxChanges` beside `signal`.
