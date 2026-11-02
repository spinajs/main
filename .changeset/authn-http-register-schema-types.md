---
"@spinajs/authn-http": patch
---

`@spinajs/authn-http/register-schema` resolves its types under `moduleResolution: node` too: the `typesVersions` map lists it. `npm run check:packages` now fails a package whose `typesVersions` map leaves out a typed subpath export.
