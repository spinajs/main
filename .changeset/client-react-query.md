---
"@spinajs/client": minor
---

`generateClientFiles({ hooks: ['react-query'] })` now writes the React Query hooks, next to the shared `client.keys.ts` and `client.react.ts`:

- `client.queries.ts` (server-safe: no `'use client'`, no React import). `appQueries.<controller>.<handler>(client, vars)` returns `queryOptions` for every GET route, with the `appKeys` key and `AppClientError` as the error type. It takes the client as a parameter, so loaders and Server Components can `prefetchQuery`, `ensureQueryData` or `useSuspenseQuery` with a per-request client. A GET with an empty reply resolves to `null`, because React Query rejects `undefined` data.
- `client.react-query.ts` (first statement `'use client'`). A `use<Controller><Handler>(vars, options?)` query hook per GET route, and a `use<Controller><Handler>(options?)` mutation hook per POST, PUT, PATCH and DELETE route, keyed with `appKeys.<controller>.<handler>`. After a success, a mutation invalidates `appKeys.<controller>.all` and stays pending until the refetch settles; the `invalidate` option replaces that list, and `invalidate: false` turns it off. The app's `onSuccess` runs after that, with every argument React Query passes. The option types are exported as `QueryOpts<T>` and `MutationOpts<T, V>`.

Variables are one object keyed by argument name, as in `client.keys.ts`: `useUsersGet({ id })`, `mutate({ body })`, and `mutate({})` for a route without arguments. The `react-query` target is now available. Tested against `@tanstack/react-query` 5.0.0 and 5.104.5, with React 18 and 19 types. `RouteModel` gains `returnTypeNames`, the named types its reply mentions. Without `hooks: ['react-query']`, the output is unchanged.
