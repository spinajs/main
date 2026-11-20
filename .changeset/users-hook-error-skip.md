---
"@spinajs/users": patch
---

`QueueAuthnEventListener` emits no `UserLoginFailed` for a login whose action hook failed (reason `hook_error`): the credentials were not wrong, so `InvalidCredentials` would mislead a consumer that counts failed logins. Webhooks and the security trail still receive the event; a deliberate hook refusal (`hook:<code>`) still emits `UserLoginFailed`.
