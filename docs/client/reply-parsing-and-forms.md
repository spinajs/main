# Reply parsing and form errors

Two optional pieces of `@spinajs/client` that work with the generated zod schemas (`client.zod.ts`). Neither is on by default: a client built without them behaves as in 4.0.

## Reply parsing

`ClientOptions.parseReply` runs on every JSON reply after it is parsed. Its result is what the call returns, and an exception rejects the call.

```ts
parseReply?: (route: { controller: string; name: string }, value: unknown) => unknown;
```

It is not called for a 204, a `void` route, a text reply or an error status (an error becomes a `ProblemError` as before). When models are on, decoding runs after `parseReply`.

### Generated lenient schemas

With `generateClientFiles({ manifest, zod: { replies: true } })` (the CLI flag is `--zod-replies`), `client.zod.ts` also holds:

- a `<Name>Reply` variant of every schema a route replies with, and of the schemas those reach;
- `replySchemas`, keyed by controller and handler like `routeSchemas`;
- `zodReplies(schemas = replySchemas)`, which returns a `parseReply`.

```ts
import { zodReplies } from './generated/client.zod.js';

const api = createAppClient({ baseUrl, parseReply: zodReplies() });
```

The request schemas stay as strict as the server. The reply variants are lenient on purpose: a closed object (`additionalProperties: false`) **strips** the keys it does not declare instead of rejecting them, because a server deployed ahead of the frontend may add reply fields, and `manifest:diff` calls that non-breaking. Everything else the server promises is still checked: types, required properties, formats and limits. A route without a reply schema (`void`, a scalar, a schema the server's Ajv refuses) is passed through.

Limits to know:

- An object with checks that read the parsed value (a `required` for a property the object does not declare, or parts of an `allOf` folded into one) keeps its unknown keys instead of stripping them, because stripping first would make those checks fail.
- The parts of a node that are folded into a refine fail as one issue at the object's path, not at the property inside. Read `error.issues[0].path` as the object, and do not expect a per-field message.
- A whole-body root with checks no longer strips undeclared keys either (see above).

Diagnostics for the reply variants are those of the request schemas; the lenient build reports nothing extra.

## Form errors

`applyProblem(error, setError)` maps the validation errors of a 400 onto form fields. It is typed structurally, so it takes react-hook-form's `form.setError` and the runtime imports no form library.

```tsx
import { zodResolver } from '@hookform/resolvers/zod';
import { applyProblem } from '@spinajs/client/runtime';

const form = useForm({ resolver: zodResolver(routeSchemas.users.create.body) });
const create = useUsersCreate({ onError: (e) => applyProblem(e, form.setError) });
```

It returns `true` when it set at least one field, so the caller can fall back to a toast:

```ts
onError: (e) => applyProblem(e, form.setError) || toast.error('Could not save')
```

Mapping, from the Ajv errors in `ProblemError.problem.errors`:

| Ajv error | Field |
| --- | --- |
| `instancePath: '/address/city'` | `address.city` |
| `instancePath: '/items/0/qty'` | `items.0.qty` |
| `required`, `params.missingProperty: 'name'` at the root | `name` |
| `additionalProperties`, `params.additionalProperty: 'zip'` at `/address` | `address.zip` |
| an error on the whole body (`instancePath: ''`, no property) | `root` |

JSON pointer escapes (`~1`, `~0`) are undone. When a field has several errors, `setError` gets the first. `problemFieldErrors(problem)` returns all of them per field, `{ keyword, message }`, for a UI that lists every message.

The `type` passed to `setError` is the Ajv keyword (`format`, `minLength`, `required`), the `message` is Ajv's.

### Where the errors come from

`@spinajs/http` answers a failed validation with the fields of the `ValidationFailed` exception, with the Ajv errors in `parameter` (reduced to `instancePath`, `schemaPath`, `keyword`, `params`, `message`), and no request value in them. The client's `ProblemError.problem.errors` takes the body's `errors` member when there is one (RFC 9457 extension) and `parameter` otherwise, so both server shapes reach `applyProblem`.
