---
"@spinajs/authn-http": minor
---

One client address for authn and the http limiters. The new `AuthnRealIp` (exported) is registered over `@spinajs/http`'s `RealIp` and runs at Order 0: `req.storage.realIp` and `req.storage.proxyTrust` follow `authn.http.trustProxy`, else `http.trustProxy`, so `@RateLimit`, `http.throttle`, `@Ip()` and the same-origin and CSRF guards count the client that `@IpThrottle`, the authn services and the audit log count. An app that set only `authn.http.trustProxy` used to rate limit every client as its proxy. `ClientIp` now copies `req.storage.realIp` (the socket address when `RealIp` did not run) and reads no trust setting of its own; a subclass that changed the address extends `AuthnRealIp` instead. `@IpThrottle` and the passkey and registration routes key IPv6 clients by `authn.throttle.ipv6Prefix`, else `http.throttle.ipv6Prefix`.
