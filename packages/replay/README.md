# `@spinajs/replay`

The domain-free core of replay: would a logged computation answer the same if it ran again at the instant it was made.

- `stateAt(t, input)`: the state of one keyed record at an instant, from its row now and its changes in a history stream, or a gap that names why it cannot be told. `coverageGap` and `sameImage` are the two checks it is built from.
- `ReplayChange`: one change of one key (`entity`, `key`, `op`, `image`, `before`, `at`, `seq`, `traceId`), the shape every history stream is read as.
- The contracts of a replayable domain: `Recording` and `RecordingSource` (what ran), `ArtifactSource` (the versions it ran on), `StateSource` and `StateView` (state at the instant), `Replayer` (the domain's own evaluation), `ReplayReport` and `ReplayService`.

A `ReplayOutcome` whose `outcome` is other than `'unknown'` asserts that no input listed in `missing` could change it; a replayer that cannot assert that returns `'unknown'`.

`sameImage` compares two texts of a JSON object or array by value, with orm-history's rule for numbers a double cannot keep; a scalar text compares exactly. This is wider than history, which compares by value only in a column it knows as JSON: a plain text column holding object or array text, and a string nested in a JSON value, compare by value here too. It can only hide a write made outside the history.

The package reads no database and imports no other SpinaJS package: the history of ORM models and each domain are added by other packages.
