---
"@spinajs/authn": patch
"@spinajs/authn-testing": patch
---

The listeners that are not blocking hear a login only after the blocking ones took every event of it. `DefaultAuthnService` and `FakeAuthnService` hand each event of a login (`login`, `session.issue`), an MFA challenge, an MFA completion and a step-up to the blocking listeners first, and tell the others only when every one was taken. A login whose `session.issue` a blocking listener stopped no longer sends a webhook or a `UserLogged` for its `login` event: those listeners receive the `listener_failed` failures only. A blocking listener sees the same events as before. New: `AuthnAudit.holdIn(ctx, body)` (also on `AuthnAudit.over`) and the protected `FakeAuthnService.hold(ctx, event)`.
