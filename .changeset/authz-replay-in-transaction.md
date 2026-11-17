---
"@spinajs/authz": minor
"@spinajs/authz-orm": patch
"@spinajs/authz-http": patch
---

`ReplayInTransaction` (an `AuthzConfigError`, exported beside `ReplayBusy`) is what `DbDecisionReplay` throws for a replay inside a transaction open on the authz connection. The decisions route answers only that error with 500 `{ error: 'replay_refused' }`; any other `AuthzConfigError` of a replay is an ordinary 500. `authz:replay` prints `authz:replay: refused: <message>` for it.
