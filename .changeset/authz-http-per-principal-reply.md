---
"@spinajs/authz-http": patch
---

`AuthzFieldsMiddleware` and `AuthzFieldTransformer` declare `static readonly PerPrincipalReply = true`, the convention by which `@spinajs/cache-http` recognises a middleware or a data transformer that filters the reply per caller and never gives such a reply to another caller. Nothing changes at run time: nothing in `@spinajs/authz-http` or `@spinajs/http` reads the member.
