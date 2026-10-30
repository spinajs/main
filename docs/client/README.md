# @spinajs/client

Typed HTTP client for SpinaJS applications.

```ts
import { createClient, ProblemError } from '@spinajs/client/runtime';

const client = createClient<{ users: Users }>(definition, {
  baseUrl: 'https://api.example.com',
  headers: async () => ({ authorization: `Bearer ${await token()}` }),
  onProblem: (p) => console.warn(p.title),
});

try {
  await client.users.get(7);
} catch (e) {
  if (e instanceof ProblemError) console.error(e.status, e.problem.title);
}
```

A route definition lists how each positional argument travels in `args`, one entry per argument: `{ in, name?, shape, multiple? }`, the manifest's `wire` binding of the route parameter.

| `shape` | Sent as |
| --- | --- |
| `value` | the argument as one string under `name`, in the query, a `{name}` path segment, a header or a cookie |
| `json` | `JSON.stringify(argument)` under `name` |
| `whole` | the argument's own keys: flat query keys, path segments, headers or form parts; in the body, the argument is the body |
| `field` | `{ [name]: argument }`, merged with the other `field` arguments into one JSON body |

A `multipart` argument is a form part (a `Blob` or `File` is sent as a file); with `multiple`, each array item is one part under `name`. A `whole` multipart argument (`@Form()`) sends its keys as form fields, nested objects and arrays as `a[b]` and `a[0]` keys, because the server reads them back with `qs` (which turns an array of more than 20 items into an object). A body argument cannot travel with multipart arguments: the server reads no body from a multipart request, so the runtime throws `TypeError` for that combination. An `undefined` or `null` argument sends nothing, except a missing path argument, which throws `TypeError`.

A `whole` body argument that is a `Blob` is sent as is; anything else is JSON. `@RawBody()` and `@FromXml()` arguments therefore arrive as JSON unless you pass a `Blob` holding the exact bytes or the XML text.

The route `path` is a template: `{name}` takes one segment, `{*name}` an array of segments joined with `/`, `[...]` is an optional group left out when a placeholder inside it has no value, and `\` escapes the next character. Each segment is percent-encoded. A segment value of `''`, `.` or `..` throws `TypeError` before any request is made, because URL parsing would resolve it into a different path (`/users/../avatar` is `/avatar`).

Header arguments and the names and values from `options.headers` must be valid HTTP: a CR, LF or a character beyond Latin-1 throws `TypeError` (encode such values yourself). Header names are lower-cased, so an argument header replaces an option header of the same name. Cookie arguments go into the `Cookie` header, which browsers drop from `fetch` without an error: they work from Node and other server runtimes only. In a browser, set `credentials: 'include'` and let the browser send its own cookies.

A reply that is not 2xx rejects with `ProblemError`. Its `problem` holds only the RFC 9457 members (`type`, `title`, `status`, `detail`, `instance`) and the `code` and `errors` extensions the server declares, each only when it has the right type; anything else in the body, such as `stack`, is dropped. Missing members default to `about:blank`, the status text and the status code. A body that is not JSON, or does not parse, becomes the `detail`.

Query strings are flat, as Express 5's default `simple` parser (`node:querystring`) reads them: an array repeats its key (`c=1&c=2`), and an object value throws `TypeError` because the parser does not nest brackets. Objects travel as `json` or `whole` arguments instead.

A hand-written definition without `args` keeps the positional slots `params`, `query`, `body`: a `{ name: value }` object for the path, one for the query, then the body, each present only when the route declares it. Replies with status 204, or routes marked `void`, resolve to `undefined`.

## Generating the client

`spinajs generate:client` reads `app.manifest.json` and writes a typed client (default `src/generated/client.ts`):

```sh
spinajs generate:client --manifest app.manifest.json --out src/generated/client.ts
```

```ts
import { createAppClient } from './generated/client';

const client = createAppClient({ baseUrl: 'https://api.example.com' });
const user = await client.users.get(7);
```

The file holds one DTO type per named schema, one interface per controller (`UsersClient`), an `AppClient` that keys them by controller name (`users`), and the route table for `createClient`.

- Each route calls its manifest `fullPath`, the path the server answers at. A bare `@Get()` on `list()` under `@BasePath('users')` is `/users/list`. `fullPath` leaves out `http.controllers.route.prefix`, so a configured prefix belongs in `baseUrl`.
- Express 5 path syntax is kept: an optional group `{/:id}` makes its arguments optional and is left out when they are `undefined`, and a wildcard `*path` takes a `string[]`. Syntax Express 5 refuses (`:id(\d+)`, `?`, `+`) fails generation with an error naming the route. Any other path argument is required, even when the controller parameter is optional, because the URL cannot be built without it.
- A route with a `@Body()` next to a file or form argument fails generation: the handler would receive `null` for the body. Send those values with `@FormField()`.
- A method takes one argument per route parameter the client sends, in the controller's order and with the parameter's name and type: `list(@Query() query: ListQuery)` becomes `list(query: ListQuery)`, sent as `?query=<json>`. Arguments the server injects (`@FromDI`, `@Req`, `@Ip`, ...) are left out. A file parameter is `Blob | File`, or an array of them for `@Files`. An optional argument before a required one is typed `T | undefined`. Arguments are positional: swapping two controller parameters of the same type swaps them at existing call sites after regeneration, without a compile error.
- A path placeholder that no parameter reads still takes an argument (`string | number`, or `string[]` for a wildcard), because the server needs the segment.
- A parameter without a `wire` binding (a manifest from an older compiler) fails generation with an error naming the route and the parameter. Rebuild the manifest.

Socket controllers become `defineContract` constants (`chatContract`) from `@spinajs/http-socket-common`; pass `--no-socket` to leave them out and `--module <path>` to import the runtime from somewhere other than `@spinajs/client/runtime`.

The same generator is available as `generateClient({ manifest, moduleName?, includeSocket? })`, which resolves to the file contents. Output is deterministic for a given manifest. Types the analyzer could not derive (a dependency's model, a partly evaluated `@Schema`) are typed as open objects or `unknown`.

Install `@spinajs/client` next to `@spinajs/cli` to use the command.
