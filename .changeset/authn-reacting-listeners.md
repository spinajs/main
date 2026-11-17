---
"@spinajs/authn-http": major
"@spinajs/authz-http": major
"@spinajs/users": major
---

The classes that react to authentication events are `AuthnEventListener`s: `WebhookAuthnEventListener` (was `WebhookAuthnEventSink`), `SseSessionEndListener` (was `SseSessionEndSink`) and `QueueAuthnEventListener` (was `QueueAuthnEventSink`). Their behaviour is unchanged; a subclass renames `publish` to `on`.

`QueueAuthnEventListener` emits no `UserLoginFailed` for a login that a blocking listener stopped (reason `listener_failed`): the credentials were right, so `InvalidCredentials` would be wrong, and a consumer counting failed logins would count an outage of the audit store.
