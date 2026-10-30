---
"@spinajs/validation": minor
"@spinajs/http": minor
---

Request validation from the manifest. In `prefer` or `require` mode, a route argument (`@Body`, `@Query`, `@Param`, `@Header`, `@Cookie`, `@BodyField`, `@QueryField`, `@ParamField`, `@HeadersField`) without an explicit schema is validated against the JSON Schema the compiler derived from its type, so DTOs need no `@Schema` that repeats the class. An explicit schema (route, decorator or class `@Schema`, JSON or Standard Schema) always wins. Query, path, header and cookie values are coerced to the derived types; JSON bodies never are. `x-explicit: 'partial'` schemas and dependency models never reject more than the runtime, and an intersection of closed objects is checked as one object. Errors keep the `ValidationFailed` / problem+json shape. `@spinajs/validation` adds `ManifestSchemaSource`, `manifestValidatorOf` and `prepareManifestSchemas`. `off` mode is unchanged.
