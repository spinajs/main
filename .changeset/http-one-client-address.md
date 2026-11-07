---
"@spinajs/http": patch
---

Docs and descriptions only: `RealIp` is the one source of the client address, and `@spinajs/authn-http` replaces it with `AuthnRealIp` so `authn.http.trustProxy` feeds it. No behaviour change in `@spinajs/http`.
