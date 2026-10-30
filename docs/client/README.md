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

A `multipart` argument is a form part (a `Blob` or `File` is sent as a file); with `multiple`, each array item is one part under `name`. Body arguments then go into the same form. An `undefined` or `null` argument sends nothing, except a missing path argument, which throws `TypeError`.

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

- Each route calls its manifest `fullPath`, the path the server answers at. A bare `@Get()` on `list()` under `@BasePath('users')` is `/users/list`.
- A method takes one argument per route parameter the client sends, in the controller's order and with the parameter's name and type: `list(@Query() query: ListQuery)` becomes `list(query: ListQuery)`, sent as `?query=<json>`. Arguments the server injects (`@FromDI`, `@Req`, `@Ip`, ...) are left out. A file parameter is `Blob | File`, or an array of them for `@Files`. An optional argument before a required one is typed `T | undefined`.
- A path placeholder that no parameter reads still takes an argument (`string | number`), because the server needs the segment.
- A parameter without a `wire` binding (a manifest from an older compiler) fails generation with an error naming the route and the parameter. Rebuild the manifest.

Socket controllers become `defineContract` constants (`chatContract`) from `@spinajs/http-socket-common`; pass `--no-socket` to leave them out and `--module <path>` to import the runtime from somewhere other than `@spinajs/client/runtime`.

The same generator is available as `generateClient({ manifest, moduleName?, includeSocket? })`, which resolves to the file contents. Output is deterministic for a given manifest. Types the analyzer could not derive (a dependency's model, a partly evaluated `@Schema`) are typed as open objects or `unknown`.

Install `@spinajs/client` next to `@spinajs/cli` to use the command.
