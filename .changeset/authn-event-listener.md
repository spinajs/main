---
"@spinajs/authn": major
"@spinajs/configuration": patch
---

`AuthnEventListener` (`on(event)`, optional `ready()` and `flush()`) is the port for classes that react to authentication events; `AuthnAudit` delivers to every registered listener, each bounded by `authn.audit.listenerTimeoutMs` (renamed from `sinkTimeoutMs`). `AuthnAudit.sinks()` is `listeners()` and `AuthnAudit.over()` takes listeners and `listenerTimeoutMs`. `AuthnEventSink` is deprecated and removed before 4.0 is released: extend `AuthnEventListener` and rename `publish` to `on`.
