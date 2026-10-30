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
  await client.users.get({ id: 7 });
} catch (e) {
  if (e instanceof ProblemError) console.error(e.status, e.problem.title);
}
```

A route method takes positional arguments in the order `params`, `query`, `body`; a slot is present only when the route declares it. Query values are serialised as `a[b]=1&c[0]=1`, matching the server's `qs` parser. Replies with status 204, or routes marked `void`, resolve to `undefined`.

## Generating the client

`spinajs generate:client` reads `app.manifest.json` and writes a typed client (default `src/generated/client.ts`):

```sh
spinajs generate:client --manifest app.manifest.json --out src/generated/client.ts
```

```ts
import { createAppClient } from './generated/client';

const client = createAppClient({ baseUrl: 'https://api.example.com' });
const user = await client.users.get({ id: 7 });
```

The file holds one DTO type per named schema, one interface per controller (`UsersClient`), an `AppClient` that keys them by controller name (`users`), and the route table for `createClient`. Method arguments follow the runtime order: `(params, query, body)`, each present only when the route declares it. A route with a query shape takes one optional `query` object; a route with a form takes `{ [field]: value | Blob | File }`.

Socket controllers become `defineContract` constants (`chatContract`) from `@spinajs/http-socket-common`; pass `--no-socket` to leave them out and `--module <path>` to import the runtime from somewhere other than `@spinajs/client/runtime`.

The same generator is available as `generateClient({ manifest, moduleName?, includeSocket? })`, which resolves to the file contents. Output is deterministic for a given manifest. Types the analyzer could not derive (a dependency's model, a partly evaluated `@Schema`) are typed as open objects or `unknown`.

Install `@spinajs/client` next to `@spinajs/cli` to use the command.
