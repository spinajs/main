---
"@spinajs/intl-http": minor
---

`IntlHttpMiddleware.onAfter` sets `Content-Language` on every framework reply when the language is a language tag (`pt_BR` as `pt-BR`; another value gets none and the request answers as before), unless the answer set its own, and adds the request headers the detection reads to `Vary` (`Cookie` and `X-<name>`, from the new protected `varyHeaders()`), keeping the fields already there; `intl.http.vary: false` (new schema `INTL_HTTP_CONFIGURATION_SCHEMA`) turns `Vary` off for a cache that keys on the URL itself. A subclass whose `detectLanguage(req)` reads `Accept-Language` adds it in `varyHeaders()`.
