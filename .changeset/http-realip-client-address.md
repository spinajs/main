---
"@spinajs/http": minor
"@spinajs/authn-oidc": patch
---

`RealIp.clientAddress(req)` is the one override point for where the client address comes from: `onBefore` writes its result to `req.storage.realIp`, and a subclass overrides it to read another header (eg. a CDN's) instead of overriding `onBefore`. It takes a `ClientAddressSource` (`headers`, optional `socket.remoteAddress`), so anything shaped like a request can be passed. `RealIp.effectiveTrust()` is now public: the trust `proxyTrust()` resolved, which `onBefore` stores in `req.storage.proxyTrust`.

`@spinajs/authn-oidc` takes the proxy trust for the default `redirect_uri` and `post_logout_redirect_uri` origin from the request (`requestProxyTrust(req)`, the trust `RealIp` stored) instead of parsing `authn.http.trustProxy` and `http.trustProxy` again, so a `RealIp` subclass that overrides `proxyTrust()` decides it too. `OidcConnection` gains `proxyTrust`.
