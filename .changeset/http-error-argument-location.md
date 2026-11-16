---
"@spinajs/http": minor
---

Each item of the `errors` list of a 400 `application/problem+json` for an argument validated against its manifest-derived schema now says which argument it belongs to: `in` (`body`, `query`, `path`, `header` or `cookie`) and `name`, the key the argument has on the wire. `name` is absent when the argument is the whole body, query, path or header set. Each argument is validated on its own, so `instancePath` is relative to the argument; without these members a client cannot tell the second of two `@Body()` arguments from the first, or a single `@Query()` value from the whole query. An explicit `@Schema`, a route schema, a file or multipart refusal and the strict-header refusal set neither. The members are additive; the other fields are unchanged.
