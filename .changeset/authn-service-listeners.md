---
"@spinajs/authn-local": major
"@spinajs/authn-totp": major
"@spinajs/authn-webauthn": major
"@spinajs/authn-testing": major
---

Services built outside DI take their event listeners as `listeners` (was `sinks`): `LocalPasswordServiceDeps.listeners`, `TotpServiceDeps.listeners`, `WebAuthnPasskeyServiceDeps.listeners`, `FakeAuthnServiceDeps.listeners`. The harness port of `@spinajs/authn-testing` is `listeners` as well.

`FakeAuthnService` delivers as `AuthnAudit` does (`AuthnAudit.over`): a listener listed twice gets each event once, a failing listener no longer fails the operation, and a failing blocking listener stops it with `AuthnListenerFailed`, revokes the session it had just issued and re-publishes the told events as failures with reason `listener_failed`.
