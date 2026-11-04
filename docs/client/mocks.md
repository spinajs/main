# Mocks

`generateClientFiles({ manifest, mocks: true })` writes `client.mocks.ts` next to `client.ts`. The file holds:

- `mock<Dto>(overrides?, options?)` for every schema `client.ts` declares;
- `mockPage` and `mockCursorPage`, re-exported from `@spinajs/client/mocks`;
- `createMockAppClient(impl, options?)`, a typed `AppClient` with no network.

The data comes from the same JSON Schema the server validates with, so every mock passes the server's validation of its DTO. Only `client.msw.ts` imports `client.mocks.ts`, so the mocks stay out of production bundles. Import the file from tests and stories only.

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

## Server behaviour the mocks mirror

Three behaviours of the server's schema handling show through in mocks. They are the server's, not the mocks', and the mocks follow them so that their data passes.

- **An optional property named like an `Object.prototype` member is required.** Ajv reads the inherited function for a declared `toString`, `valueOf` or `hasOwnProperty`, so an object without its own key fails. The mock always writes such a property, even with `optional: 'some'`. A declared `constructor` is the same, and only `{}` can be met without a forbidden key.
- **`allOf` opens its closed members.** Even when the result stays open because one member is open, the closed members lose `additionalProperties: false`, so `A & { z?: string }` accepts extra keys. The mock still writes only declared keys.
- **A property named `__proto__` breaks the schema.** The server copies schemas with assignment, which sets a prototype, and Ajv then refuses the schema, so every request to that route fails. The mock reports `MOCK001`.

## The fake client

```ts
const client = createMockAppClient(impl, { fallback: 'throw', seed: 1 });
```

- A method in `impl` is called with the arguments.
- A method missing from `impl` rejects with `MockNotImplemented`: "createMockAppClient: users.get is not implemented; pass it in the first argument".
- With `fallback: 'mock'`, a missing method resolves to mock data of its reply type, from `seed`. A route that answers with no body resolves to `undefined`. A reply type with no schema and no primitive type (`unknown`, an array of strings) has nothing to sample: the generator reports `MOCK001` for the route, and the fallback rejects with `MockUnsupported`.

The client is typed as `AppClient`, so it fits wherever the app expects the real one, such as the hooks provider in component tests.

## Pages

```ts
mockPage(item, { total, page, pageSize, firstPage }); // { items, total }
mockCursorPage(item, { count, next }); // { items, next }
```

`item(i)` gets the index of the item across all pages. `mockPage` defaults to one full page of 20 items, with pages counted from `firstPage` (default 1). `mockCursorPage` defaults to 20 items and `next: null`.

## MSW handlers

`generateClientFiles({ manifest, mocks: true, msw: true })` also writes `client.msw.ts`: one [MSW](https://mswjs.io) request handler per route, answering with the data of `client.mocks.ts`. `msw` without `mocks` throws, because the handlers need the mock data. `client.msw.ts` is the only generated file that imports `msw`, and it has no `'use client'` directive and no React import, so it runs in Node test runners and in browsers.

```ts
import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createAppHandlers } from './generated/client.msw.js';

const server = setupServer(
  ...createAppHandlers('http://localhost:3000', {
    users: { get: ({ params }) => HttpResponse.json({ id: Number(params.id), email: 'ada@example.com' }) },
  }),
);
server.listen();
```

- `createAppHandlers(baseUrl, overrides?)` returns `RequestHandler[]`. A trailing slash on `baseUrl` is ignored.
- `overrides` is typed `AppHandlerOverrides`, keyed `controller.handler`. Each value is an MSW response resolver whose reply must have the route's reply type, so `HttpResponse.json({ wrong: true })` fails `tsc`. Path parameters are typed by name.
- A route with no reply answers `204`. Any other route answers with `createMockAppClient` data, from the same seed every time. A reply the sampler cannot honour (`MOCK001`) answers with status `500` and a body whose `name` is `MockUnsupported`; override it to give that route data. A `file` route is handled like a `GET`, so one that replies with a `Blob` is such a case.
- MSW uses the first handler that matches. Within one controller the handlers follow the order of the routes, which is Express's order, so `/users/me` declared before `/users/:id` wins for `/users/me` in both. Across controllers they follow the order of `client.ts` (sorted by class name), not the order in which the server registers its controllers: if two controllers overlap, the server's registration order decides in Express and can differ from the handlers.
- MSW matches paths case-sensitively, whereas Express matches them case-insensitively by default. The generated client always sends the path in the case of the manifest, so the handlers match what it sends; a request in another case gets no handler.

### Paths

Paths come from the manifest and are translated from Express 5 to MSW syntax:

| Express 5 | MSW |
| --- | --- |
| `/users/:id` | `/users/:id` |
| `/a{/:id}` | two handlers: `/a/:id`, then `/a` |
| `/a{/:id}{/:sub}` | four handlers, one per combination; the earlier group fills first, so `/a/7` gives `params.id` as in Express |
| `/files/*path` | `/files/*`, read as `params['0']` |
| `/a\:b`, `/a\*b` | the same, with the backslash kept |
| `/a/b\?c` | `/a/b%3Fc`: MSW ignores the query of a request, so a literal `?` matches only as the encoded path character |
| `/a/b\c` | `/a/b\c`: a literal backslash, matched against `%5C` |

MSW has no optional groups and no named wildcards, so an optional group becomes one handler per combination, all sharing the override. A parameter name MSW cannot read (anything but letters, digits and underscores, such as `:"my-id"` or `:$id`) gets no handler: the generator reports diagnostic `MSW001` on `client.msw.ts`, naming the controller, the handler and the path, and writes the other routes. Aborting would lose `client.ts` for the sake of one route.

### Requirements

`msw` is an optional peer dependency, `^3.0.0`; install it where the handlers run. MSW 3 needs Node 22.12 or later, a little above SpinaJS's own floor, and uses the global `fetch`, so no polyfill is needed. The server option that MSW 2 called `onUnhandledRequest` is `onUnhandledFrame` in MSW 3.
