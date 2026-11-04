---
"@spinajs/http": minor
---

Each item of the `errors` list of a 400 `application/problem+json` for a failed request validation now says which argument it belongs to: `in` (`body`, `query`, `path`, `header` or `cookie`) and `name`, the key the argument has on the wire. `name` is absent when the argument is the whole body, query, path or header set. Each argument is validated on its own, so `instancePath` is relative to the argument; without these members a client cannot tell the second of two `@Body()` arguments from the first, or a single `@Query()` value from the whole query. The members are additive; the other fields are unchanged.
