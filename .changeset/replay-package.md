---
"@spinajs/replay": minor
---

New package `@spinajs/replay`, the domain-free core of replay. `stateAt` answers the state of one keyed record at an instant from its row now and its changes in a history stream, or a gap that names why it cannot be told (`coverageGap`, `sameImage`). `ReplayChange` is the change shape every stream is read as. `Recording`, `RecordingSource`, `ArtifactSource`, `StateSource`, `StateView`, `Replayer`, `ReplayReport` and `ReplayService` are the contracts of a replayable domain. The package has no dependency and nothing uses it yet.
