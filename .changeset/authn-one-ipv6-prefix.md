---
"@spinajs/authn": minor
"@spinajs/authn-keys": patch
"@spinajs/authn-local": patch
"@spinajs/authn-totp": patch
---

One IPv6 prefix: `authn.throttle.ipv6Prefix` has no shipped default any more and, unset, takes `http.throttle.ipv6Prefix`, else 64 (`ipv6PrefixOf(authnPrefix, httpPrefix)`), so authn's ip keys and `@RateLimit` / `http.throttle` count the same network. The authn boot warns once, and `authn:check-config` reports, when `authn.http.trustProxy` and `http.trustProxy` are both set and differ (`proxy`; `authn.http.trustProxy` wins), and when `authn.throttle.ipv6Prefix` differs from `http.throttle.ipv6Prefix` (`throttle`). New export `clientAddressFindings(config)` from `@spinajs/authn/boot`.
