---
"@spinajs/tenancy-http": minor
---

`@spinajs/tenancy-http/socket`: a socket connection gets one tenant for its life, resolved in the handshake with the resolvers of `tenancy.http.resolvers` and copied into the store of every command, event and hook. A browser names its tenant in the handshake `auth.tenant`, honoured like the header only for an authenticated principal that may enter. A handshake that names an unknown, inactive or forbidden tenant is refused with `not_found` (`forbidden` with `tenancy.http.unknownTenant: 403`); one that names none connects with no tenant scope.
