---
"@spinajs/cache-http": minor
---

New package `@spinajs/cache-http`, the response cache of SpinaJS http routes: the options of `@ResponseCache`, checked where they are written (a `'tenant'` or `'shared'` scope needs a `sharedBecause` reason), the key of a stored reply (`responseCacheKey` with the parts `ResponseCacheKeyPart`, `LanguageKeyPart` and the principal part `responsePrincipal`; a per-principal request without an authenticated principal has no key), what of a reply is stored (`replyToStore`, `replayableReply`: a 200 JSON reply, never a cookie or a header of one connection) and `CachedResponse`, the reply a cache hit sends.
