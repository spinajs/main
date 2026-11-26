---
"@spinajs/compiler": patch
---

`@Access(…, { fields: X })` with an `X` the build cannot read (a call, a `let` or `var`, options it cannot follow to an object literal, a spread or a computed key it cannot read written after the last `fields`) is recorded with the fields filter (`AuthzFieldsMiddleware`). Before, such a route was recorded as unredacted. Shapes the build now reads for the first time also record a route whose `fields` is `'filter'` or `'filter-rows'` as filtered where nothing was recorded before: options in a constant (`@Access(p, OPTIONS)`), a shorthand `{ fields }`, options wrapped in `satisfies` or parentheses, and a constant declared in a package's `.d.ts`.

For each such route the generated client returns `Redacted<T>` instead of `T`, so code that relies on the reply's properties being required may stop compiling, and the OpenAPI schema of its response loses `required` and marks each property with `x-spina-fields`, so a committed `openapi.json` changes once. `AUTHZ008` does not report a route whose `fields` cannot be read; the build notes it instead with `CMP001` "the fields option of @Access cannot be read (…): recorded as filtering, AUTHZ008 does not check this route". To keep a route unredacted, write `fields` as a literal or a `const` the build can read.
