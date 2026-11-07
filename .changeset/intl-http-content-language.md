---
"@spinajs/intl-http": minor
---

`IntlHttpMiddleware.onAfter` sets `Content-Language: <storage.language>` on every framework reply, unless the answer set its own, and adds the request headers the detection reads to `Vary` (`Cookie` and `X-<name>`, from the new protected `varyHeaders()`), keeping the fields already there. A subclass whose `detectLanguage(req)` reads `Accept-Language` adds it in `varyHeaders()`.
