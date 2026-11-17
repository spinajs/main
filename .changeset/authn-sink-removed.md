---
"@spinajs/authn": major
"@spinajs/authn-testing": major
---

`AuthnEventSink` is removed; `AuthnEventListener` (`on(event)`) is the only port for classes that react to authentication events. `RecordingEventSink` of `@spinajs/authn-testing` is `RecordingEventListener`.
