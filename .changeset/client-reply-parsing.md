---
"@spinajs/client": minor
---

Two opt-in additions to the client runtime, and one to the zod emitter. Without them the client behaves as in 4.0.

`ClientOptions.parseReply?: (route: { controller: string; name: string }, value: unknown) => unknown` runs after a JSON reply is parsed, and its result is what the call returns; an exception rejects the call. It is not called for a 204, a `void` route, a text reply or an error status.

`applyProblem(error, setError)` maps the validation errors of a 400 onto form fields (`/address/city` becomes `address.city`, a missing property is named after the property, array indexes stay as they are) and returns whether it set any. `setError` is typed structurally, so it takes react-hook-form's `form.setError` and the runtime imports nothing. `problemFieldErrors(problem)` returns all errors per field. A 400 from `@spinajs/http` for a failed validation carries the Ajv errors in `parameter`, not in an `errors` member, so `ProblemError.problem.errors` now falls back to `parameter` when the body has no `errors`.

`generateClientFiles({ manifest, zod: { replies: true } })` adds lenient reply schemas to `client.zod.ts`: a `<Name>Reply` variant of each schema a route replies with, which strips unknown keys instead of rejecting them (a server deployed ahead of the frontend may add fields), `replySchemas` keyed by controller and handler, and `zodReplies(schemas = replySchemas)`, which returns a `parseReply` for `createAppClient`. An object whose checks read the parsed value keeps its unknown keys, and parts of a node folded into a refine fail as one issue at the object's path.
