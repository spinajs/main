---
"@spinajs/users": minor
---

New subpath `@spinajs/users/workflow`: `UserSignalPrincipalFactory` reloads the user a permissioned workflow signal is checked as. A signer who is unknown, soft deleted, inactive or banned when the wait consumes the signal is checked as `UNATTENDED`, so the signal is rejected; an active one is checked with its current attributes. `@spinajs/authz-workflow` is an optional peer dependency; import the subpath once in the application entry, as with `@spinajs/users/queue`.
