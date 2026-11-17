---
"@spinajs/authn": minor
"@spinajs/authn-testing": minor
---

`AuthnAudit.over(listeners)` also offers `publishDetached` and `settled`, the delivery `AuthnAudit` itself uses for events no listener may stop.

`FakeAuthnService` publishes like the real service: a `token.use` success goes out detached (no listener can stop or hold the request; `settled()` awaits it), a revocation that fails after a stopped announcement is logged and the operation still answers `AuthnListenerFailed`, and the new optional `log` dependency gets a warning for every listener that fails or times out.
