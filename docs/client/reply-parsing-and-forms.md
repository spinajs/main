# Reply parsing and form errors

Two optional pieces of `@spinajs/client` that work with the generated zod schemas (`client.zod.ts`). Neither is on by default: a client built without them behaves as in 4.0.

## Reply parsing

`ClientOptions.parseReply` runs on every JSON reply after it is parsed. Its result is what the call returns, and an exception rejects the call.

```ts
parseReply?: (route: { controller: string; name: string }, value: unknown) => unknown;
```

It is not called for a 204, a `void` route, a text reply or an error status (an error becomes a `ProblemError` as before). A throw from the parser is not a problem reply: `onProblem` is not called, and the caller gets the parser's error (a `ZodError` with `zodReplies`). When models are on, decoding runs after `parseReply`.

### Generated lenient schemas

With `generateClientFiles({ manifest, zod: { replies: true } })`, `client.zod.ts` also holds:

- a `<Name>Reply` variant of every schema a route replies with, and of the schemas those reach;
- `replySchemas`, keyed by controller and handler like `routeSchemas`;
- `zodReplies(schemas = replySchemas)`, which returns a `parseReply`.

```ts
import { zodReplies } from './generated/client.zod.js';

const api = createAppClient({ baseUrl, parseReply: zodReplies() });
```

The request schemas stay as strict as the server. The reply variants are lenient on purpose: a closed object (`additionalProperties: false`) **strips** the keys it does not declare instead of rejecting them, because a server deployed ahead of the frontend may add reply fields, and `manifest:diff` calls that non-breaking. Everything else the server promises is still checked: types, required properties, formats and limits. A widened enum or a new union member is a breaking change for a reply, so it is still refused. A route without a reply schema (`void`, a scalar, a schema the server's Ajv refuses) is passed through. The CLI flag for this option, `--zod-replies`, arrives with the CLI wiring of the zod target; until then pass the option to `generateClientFiles`.

What a lenient reply does with:

- **an object whose checks read the parsed value** (a `required` for a property the object does not declare): it keeps its unknown keys, because stripping first would make the check fail;
- **an open object**: stays open;
- **an `anyOf` or `oneOf` of closed objects**: the members as the server checks them are tried first, so an `Admin` that has a `role` keeps it, and only a value no member fits exactly (a newer server added a field) is parsed by the lenient members, the first that takes it. For such a value the result can be the wrong member of the union: the lenient parse of `User` strips an `Admin`'s `role`;
- **a `oneOf`** counts its matches against the members as the server checks them, so two lenient members that both strip cleanly do not make a valid reply fail.

Diagnostics of the lenient build are the ones of the request build, plus those of a reply schema no request schema covers.

## Form errors

`applyProblem(error, setError, options?)` maps the validation errors of a 400 onto form fields. `setError` is generic in the field name, so react-hook-form's `form.setError` of a typed form is accepted as is, and the runtime imports no form library.

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

### The zod schemas of a form

`zodResolver(routeSchemas…)` checks the request schemas, which are as strict as the server. Two things follow from how they are built:

- Parts of a node that the generator folds into a refine (an `allOf` next to a closed object) fail as **one issue at the object's path**, not at the property inside. Expect no per-field message for them; the server's own 400 has them per field.
- A whole-body root that carries such checks no longer strips undeclared keys: the checks read the parsed value, so the keys stay. A root without checks strips them, as the server does.

### Mapping

The errors come from `ProblemError.problem.errors`, the Ajv errors of the `application/problem+json` body of `@spinajs/http`:

| Ajv error | Field |
| --- | --- |
| `instancePath: '/address/city'` | `address.city` |
| `instancePath: '/items/0/qty'` | `items.0.qty` |
| `required`, `params.missingProperty: 'name'` at the root | `name` |
| `additionalProperties` at `/address` | `address` (the form has no input for the extra property) |
| an error on the whole body (`instancePath: ''`) | `root` |

JSON pointer escapes (`~1`, `~0`) are undone. When a field has several errors, `setError` gets the first. `problemFieldErrors(problem, options?)` returns all of them per field, `{ keyword, message }`, for a UI that lists every message.

Two ambiguities remain, as in react-hook-form itself: a property name that contains `.` cannot be told from a path, and a property called `root` shares the bucket of the whole body.

### Which argument an error belongs to

The server validates each argument on its own, so an error path is relative to the argument. Each item of `errors` therefore also carries `in` (`body`, `query`, `path`, `header` or `cookie`) and, unless the argument is the whole body, query, path or header set, `name`, the key the argument has on the wire. `applyProblem` prefixes the field with `name`:

| Request | Error | Field |
| --- | --- | --- |
| `@Body() first`, `@Body() second`, `second.count` wrong | `instancePath: '/count'`, `in: 'body'`, `name: 'second'` | `second.count` |
| `GET /sorted?sort=up` (`@Query() sort`) | `instancePath: ''`, `in: 'query'`, `name: 'sort'` | `sort` |
| `@Body() dto`, `count` wrong | `instancePath: '/count'`, `in: 'body'` | `count` |

Both members are additive, and a server older than this change sends neither: errors then map as if every argument were the whole body.

### Messages

The server sends the Ajv keyword and its params, and no text. `applyProblem` writes a short English one from them (`is required`, `must be a number`, `must be one of: asc, desc`) and passes it to `setError` as `message`, with the keyword as `type`. The `messages` option replaces it, for example with the app's own UI text:

```ts
applyProblem(e, form.setError, {
  messages: ({ keyword, params }) => (keyword === 'required' ? t('form.required') : keyword === 'type' ? t('form.wrongType', { type: params.type }) : undefined),
});
```

Return `undefined` to keep the default for that error.
