---
"@spinajs/compiler": patch
---

`@Access(…, { fields: X })` with an `X` the build cannot read is recorded with the fields filter (`AuthzFieldsMiddleware`), so OpenAPI marks the reply redactable and `CACHE002` sees it. Before, such a route was recorded as unredacted. The same holds for options the build cannot read that may set `fields`: options held in a constant it cannot read, a spread of one after the last `fields`, or a computed key.
