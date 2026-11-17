---
"@spinajs/authn": minor
---

An `AuthnEventListener` may be blocking (`get blocking(): boolean`). `AuthnAudit` hands a success event to the blocking listeners first; when one fails or runs out of `authn.audit.listenerTimeoutMs`, `publish` and `publishIn` reject with `AuthnListenerFailed` (a `CodedHttpException`, HTTP 503) and no other listener gets the event. `DefaultAuthnService` revokes a session it has just issued or elevated when its announcement is stopped. Failure events and detached events are never stopped, and without a blocking listener nothing changes.
