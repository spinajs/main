---
"@spinajs/authn-testing": patch
---

`FakeAuthnService` follows the real service more closely: listeners are flushed only by `settled()`, which now flushes them also when no detached event is pending; a success of a key strategy (`jws-assertion`, `http-signature`) is published as `key.use`, not `token.use`; and the `session.rotate` of a step-up carries `reason: 'step_up'`.
