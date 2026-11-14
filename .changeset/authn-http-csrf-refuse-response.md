---
"@spinajs/authn-http": major
---

`CsrfOriginGuard.refuse(reason, req)` returns the refusal `Response` (403, same body) instead of writing `res`, following `CsrfGuard` in `@spinajs/http`. A subclass overriding `refuse` returns a `Response`.
