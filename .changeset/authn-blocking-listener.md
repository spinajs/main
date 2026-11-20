---
"@spinajs/authn": minor
---

An `AuthnEventListener` may be blocking (`get blocking(): boolean`). `AuthnAudit` hands a success event to the blocking listeners first; when one fails or runs out of `authn.audit.listenerTimeoutMs`, `publish` and `publishIn` reject with `AuthnListenerFailed` (a `CodedHttpException`, HTTP 503) and no listener that is not blocking gets the event. `DefaultAuthnService` revokes a session it has just issued or elevated when its announcement is stopped, and publishes each event of that announcement up to the stopped one again with `outcome: 'failure'` and `reason: 'listener_failed'`; a stopped impersonation start or end does the same and answers 503. A `blocking` getter that throws counts as a blocking listener that failed. Failure events and detached events are never stopped, and without a blocking listener nothing changes.
