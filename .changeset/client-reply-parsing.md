---
"@spinajs/client": minor
---

Two opt-in additions to the client runtime, and one to the zod emitter. Without them the client behaves as in 4.0.

`ClientOptions.parseReply?: (route: { controller: string; name: string }, value: unknown) => unknown` runs after a JSON reply is parsed, and its result is what the call returns; an exception rejects the call. It is not called for a 204, a `void` route, a text reply or an error status.

`applyProblem(error, setError, options?)` maps the validation errors of a 400 problem onto form fields (`/address/city` becomes `address.city`, a missing property is named after the property, array indexes stay as they are, an error on the whole body goes to `root`) and returns whether it set any. `setError` is generic in the field name, so react-hook-form's `form.setError` of a typed form is accepted and the runtime imports nothing. The server sends only the Ajv keyword and its params, so `applyProblem` writes a short English message (`is required`, `must be a number`) and takes an optional `messages` mapper for other texts. When an error item says which argument it belongs to (`in`, `name`, from `@spinajs/http`), the field name is prefixed with the argument name. `problemFieldErrors(problem, options?)` returns all errors per field.

`generateClientFiles({ manifest, zod: { replies: true } })` adds lenient reply schemas to `client.zod.ts`: a `<Name>Reply` variant of each schema a route replies with, which strips unknown keys instead of rejecting them (a server deployed ahead of the frontend may add fields), `replySchemas` keyed by controller and handler, and `zodReplies(schemas = replySchemas)`, which returns a `parseReply` for `createAppClient`. An `anyOf` or `oneOf` of closed objects first tries the members as the server checks them, so a value that fits one keeps all its keys, and only then the lenient members. An object whose checks read the parsed value keeps its unknown keys.
