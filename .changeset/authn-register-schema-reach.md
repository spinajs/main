---
"@spinajs/authn-http": patch
"@spinajs/authn-oidc": patch
"@spinajs/http-socket": patch
---

`@spinajs/authn-http` exports `./register-schema`. The `@spinajs/authn-oidc` and `@spinajs/http-socket` modules that read `authn.*` import the registration of the schemas that own those keys, so a module loaded by a directory scan after boot reads validated values with their defaults.
