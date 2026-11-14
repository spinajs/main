---
"@spinajs/http": minor
"@spinajs/http-socket": minor
"@spinajs/authn-oidc": patch
---

`RealIp` is the one source of the client address, and `@spinajs/authn-http` replaces it with `AuthnRealIp` so `authn.http.trustProxy` feeds it. `RealIp.clientAddress(req)` is the one override point for where the client address comes from: `onBefore` writes its result to `req.storage.realIp`, and a subclass overrides it to read another header (e.g. a CDN's) instead of overriding `onBefore`. It takes a `ClientAddressSource` (`headers`, optional `socket.remoteAddress`), so anything shaped like a request can be passed. `RealIp.effectiveTrust()` is now public: the trust `proxyTrust()` resolved, which `onBefore` stores in `req.storage.proxyTrust`.

`@spinajs/http-socket` takes the handshake client address (`handshake.address`, socket `realIp`, policy `ip`) from the registered `RealIp`'s `clientAddress()` instead of parsing `authn.http.trustProxy` and `http.trustProxy` itself, so a socket and a request from one client get one address, and a `RealIp` subclass (another trust, a CDN header) applies to sockets too. Without `@spinajs/authn-http`, `authn.http.trustProxy` no longer moves the socket address. `SocketServer` resolves `RealIp` when it starts, so a bad trust entry still fails the start.

`@spinajs/authn-oidc` takes the proxy trust for the default `redirect_uri` and `post_logout_redirect_uri` origin from the request (`requestProxyTrust(req)`, the trust `RealIp` stored) instead of parsing `authn.http.trustProxy` and `http.trustProxy` again, so a `RealIp` subclass that overrides `proxyTrust()` decides it too. `OidcConnection` gains `proxyTrust`; a connection without one trusts no proxy. The protected members `OwnTrust` and `SharedTrust` of `OidcLogoutExtension` are removed.
