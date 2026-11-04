# Mocks

`generateClientFiles({ manifest, mocks: true })` writes `client.mocks.ts` next to `client.ts`. The file holds:

- `mock<Dto>(overrides?, options?)` for every schema `client.ts` declares;
- `mockPage` and `mockCursorPage`, re-exported from `@spinajs/client/mocks`;
- `createMockAppClient(impl, options?)`, a typed `AppClient` with no network.

The data comes from the same JSON Schema the server validates with, so every mock passes the server's validation of its DTO. No other generated file imports `client.mocks.ts`, so the mocks stay out of production bundles. Import the file from tests and stories only.

```ts
import { createMockAppClient, mockPage, mockUserDto } from './generated/client.mocks.js';

const user = mockUserDto({ name: 'Ada' }); // id and email generated, name overridden
const other = mockUserDto({}, { seed: 2 }); // another seed gives another user
const page = mockPage((i) => mockUserDto({}, { seed: i + 1 }), { total: 45, page: 3, pageSize: 20 }); // items 40 to 44

const client = createMockAppClient({ users: { get: async (id) => mockUserDto({ id }) } });
await client.users.get(7); // calls the implementation
await client.users.list({}); // rejects with MockNotImplemented
```

`client.mocks.ts` imports `@spinajs/client/mocks`, a runtime with no dependencies. It imports nothing outside `@spinajs/client` and works in browsers and test runners.

## Options

`mock<Dto>(overrides, options)` takes `MockOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `seed` | `1` | The same seed, schema and overrides always give the same value. |
| `optional` | `'some'` | `'some'`: each optional property appears on a seeded coin flip. `'all'`: every optional property appears. |
| `maxDepth` | `3` | From this nesting depth on, optional properties and optional array items are left out, and a `null` or scalar branch of a union is picked, so recursive types end. |
| `formats` | none | A sampler per string format, for example `{ email: () => faker.internet.email() }`. Its values must still pass the format, or the mock throws `MockError`. |

`overrides` replaces top-level properties of the generated object. The overrides are not validated.

The seed of a nested value is derived from its parent's seed and its property name. Adding a property to a DTO does not change the values of the other properties.

## What the generator honours

- `type` (with `nullable`), `const` and `enum`. Scalar `examples` and `default` come first when they pass the node's own checks.
- `required`, `properties`, `additionalProperties` and `patternProperties`. The mock never writes a key the schema does not declare.
- `minLength` and `maxLength` (counted in code points), `pattern`, `format`.
- `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `integer`, and the `int32` and `int64` ranges.
- `items` (single and tuple), `additionalItems`, `minItems`, `maxItems`, `uniqueItems`.
- `$ref` (by name and into `$defs`), `allOf`, `anyOf`, and `oneOf` when no value can match two branches. Branches cannot overlap when their types differ, or when they have a required tag property whose values differ, as the compiler writes discriminated unions. `allOf` members are merged as the server merges them: every closed member is opened, and the result is closed over their properties when all members are closed.

**Formats.** Every format the server knows has a sampler: `date`, `time`, `date-time`, `duration`, `uri`, `uri-reference`, `uri-template`, `url`, `email`, `hostname`, `ipv4`, `ipv6`, `regex`, `uuid`, `json-pointer`, `json-pointer-uri-fragment`, `relative-json-pointer`, `byte`, `password`, `binary` and `decimal` (digits, an optional fraction). A format the server does not know is ignored, as the server ignores it, unless `options.formats` names a sampler for it.

**Patterns.** The sampler understands a subset of regular expressions: literals, escapes (`\d`, `\w`, `\s` and their negations, `\x..`, `\u....`, `\u{...}`), classes and negated classes, `.`, the quantifiers `*`, `+`, `?`, `{n}`, `{n,}` and `{n,m}` (lazy ones too), groups (plain, non-capturing and named), alternation, and `^` and `$` at the start and end of an alternative. A negated class or `.` is sampled from printable ASCII.

## MOCK001

Some schemas cannot be mocked faithfully. Their mock throws `MockUnsupported` instead of giving data the server would reject. The generator reports them on the file as diagnostic `MOCK001`, with the schema id and a JSON pointer. A schema gets `MOCK001` when it, or any schema it references, has:

- `not`, `if`/`then`/`else`, `contains`, `propertyNames`, `dependencies`, `min`/`maxProperties` or any other keyword outside the list above, the app's own keywords included;
- a `$data` reference;
- a `pattern` outside the subset, unless the node has a `const`, or an `examples` or `default` value that matches it;
- a `oneOf` whose branches could both match one value;
- a schema the server's Ajv refuses: a `$schema` other than draft-07, a type that is not a JSON type, an invalid pattern, a `$ref` that does not resolve;
- a property named `__proto__` (the server cannot use that schema), a property named `constructor` with any schema other than `{}`, or a required property named `prototype`. A mock never writes these three keys.

A schema the sampler supports can still have no value, for example an empty number range or a `maxLength` shorter than its format. The mock then throws `MockError`.

## The fake client

```ts
const client = createMockAppClient(impl, { fallback: 'throw', seed: 1 });
```

- A method in `impl` is called with the arguments.
- A method missing from `impl` rejects with `MockNotImplemented`: "createMockAppClient: users.get is not implemented; pass it in the first argument".
- With `fallback: 'mock'`, a missing method resolves to mock data of its reply type, from `seed`. A route that answers with no body resolves to `undefined`.

The client is typed as `AppClient`, so it fits wherever the app expects the real one, such as the hooks provider in component tests.

## Pages

```ts
mockPage(item, { total, page, pageSize, firstPage }); // { items, total }
mockCursorPage(item, { count, next }); // { items, next }
```

`item(i)` gets the index of the item across all pages. `mockPage` defaults to one full page of 20 items, with pages counted from `firstPage` (default 1). `mockCursorPage` defaults to 20 items and `next: null`.
