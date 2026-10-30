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
