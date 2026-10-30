---
"@spinajs/validation": minor
"@spinajs/http": minor
"@spinajs/http-socket": minor
---

Request validation from the manifest. In `prefer` or `require` mode, a route argument (`@Body`, `@Query`, `@Param`, `@Header`, `@Cookie`, `@BodyField`, `@QueryField`, `@ParamField`, `@HeadersField`) or a socket `@Payload` without an explicit schema is validated against the JSON Schema the compiler derived from its type, so DTOs need no `@Schema` that repeats the class. An explicit schema (route, decorator or class `@Schema`, JSON or Standard Schema) always wins. Query, path, header and cookie values are coerced to the derived types; JSON bodies and socket payloads never are. The root of a whole body, query, path or header object accepts keys it does not declare, which other readers take (`reauthPassword`); nested objects and single body fields stay closed. `x-explicit: 'partial'` schemas and dependency models never reject more than the runtime, and an intersection of closed objects is checked as one object. Errors keep the `ValidationFailed` / problem+json shape. `@spinajs/validation` adds `ManifestSchemaSource`, `manifestValidatorOf` and `prepareManifestSchemas`. `off` mode is unchanged.
