# Hooks

`@spinajs/client` can write typed React hooks for every route of the manifest, for React Query (`@tanstack/react-query`, v5) or SWR (2.2 or later). A GET route gets a query hook and any other method a mutation hook, both named `use<Controller><Handler>`: `UsersController.get` is `useUsersGet`. [The client page](README.md) covers the client the hooks call, and [Server rendering and prefetching](ssr.md) the server side.

## Generate the hooks

```ts
import { generateClientFiles } from '@spinajs/client';

const files = await generateClientFiles({ manifest, hooks: ['react-query', 'swr'] });
```

Pick one library or both. `spinajs generate:client` runs the same generator; its flags are in the [CLI command reference](../cli/08-command-reference.md#generateclient). The files, with the default name `client`:

| File | Imports | Holds |
| --- | --- | --- |
| `client.ts` | the runtime | the client and the DTO types |
| `client.keys.ts` | no React | `appKeys`, `appTags`, `clientShapeHash`, `AppClientError` |
| `client.react.ts` | `react` | `AppClientProvider`, `useAppClient` |
| `client.queries.ts` | `@tanstack/react-query` | `appQueries`, the query options of each GET route |
| `client.react-query.ts` | `react`, `@tanstack/react-query` | the React Query hooks |
| `client.swr.ts` | `react`, `swr` | the SWR hooks |

`client.keys.ts` and `client.queries.ts` import no React, so a Server Component or a loader can use them. The other hook files start with `'use client'`. The option `keyPrefix` (default `spinajs`) is the first element of every key.

## Setup

Create the client once and give it to the tree with `AppClientProvider`. Every hook reads it with `useAppClient()`, and a hook used outside the provider throws.

```tsx
'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppClient } from './generated/client.js';
import { AppClientProvider } from './generated/client.react.js';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => createAppClient({ baseUrl: 'https://api.example.com', credentials: 'include' }));
  const [queryClient] = useState(() => new QueryClient());
  return (
    <AppClientProvider client={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </AppClientProvider>
  );
}
```

With SWR, `SWRConfig` is optional and takes the place of `QueryClientProvider`. The provider holds only the client; the cache belongs to the library.

```ts
const user = useUsersGet({ id: 7 }); // UseQueryResult<UserDto, AppClientError>
const create = useUsersCreate();
await create.mutateAsync({ body: dto });
```

- **Variables.** One object keyed by argument name: `{ id }`, `{ query }`, `{ body }`. It may be left out when the route has no arguments or only optional ones. A mutation takes its variables in `mutate(vars)`.
- **Disabled queries.** React Query: `{ enabled: false }` in the options. SWR: pass `null` as the variables, so `useUsersGet(id ? { id } : null)` fetches nothing.
- **Options.** The second argument is the library's own options without the key and the query function (`QueryOpts<T>` for React Query), or SWR's `SWRConfiguration`.

### Choosing the data type with `select`

The generated `QueryOpts<T>` fixes React Query's `TData` to the reply type `T`, so a `select` passed through `options` must return `T`. To read another type, spread the query options and let `select` set `TData`:

```ts
const client = useAppClient();
const name = useQuery({ ...appQueries.users.get(client, { id: 7 }), select: (user) => user.name }); // UseQueryResult<string, AppClientError>
```

The key stays `appKeys.users.get({ id: 7 })`: `select` runs after the cache, which keeps the full reply. Components with different `select` functions share one cache entry and one request, and an invalidation reaches all of them. SWR has no `select`; derive the value from `data`.

## Keys

`appKeys` is a tree of key builders:

```ts
appKeys.all; // ['spinajs']
appKeys.users.all; // ['spinajs', 'users']
appKeys.users.get({ id: 7 }); // ['spinajs', 'users', 'get', { id: 7 }]
appKeys.users.create; // ['spinajs', 'users', 'create'], the mutation key
```

A query hook caches under `appKeys.<controller>.<handler>(vars)`. A mutation has the constant key `appKeys.<controller>.<handler>`. Both libraries match keys by prefix, so `appKeys.users.all` covers every query of the controller.

## Invalidation

A mutation hook refreshes the queries of its own controller (`appKeys.<controller>.all`) after it succeeds, and stays pending until the refetch settles. A query that several keys match refetches once. Only mounted queries refetch; an unmounted one loads again when it mounts. A failed mutation invalidates nothing.

Pass `invalidate` to choose the keys. It replaces the default, and `false` invalidates nothing:

```ts
useUsersCreate({ invalidate: [appKeys.users.list({ query: {} }), appKeys.health.all] });
useUsersCreate({ invalidate: false });
```

React Query takes query keys, matched as prefixes. SWR takes key prefixes, matched on the serialized key.

- **Two caches.** React Query and SWR keep separate caches, even under one `AppClientProvider`. A React Query mutation does not refresh SWR keys, and an SWR mutation does not refresh React Query keys. An app that uses both libraries has to invalidate both itself.
- **Mutations await the refetch.** `await mutateAsync(vars)` returns after the invalidated queries have their new data.

## Errors

A failed call rejects with `AppClientError`, which is `ProblemError | Error`: a non-2xx reply is a `ProblemError`, a network failure is fetch's `TypeError`, and a reply that is not valid JSON is a `SyntaxError`. The query result's `error` and the rejection of `mutateAsync` hold the same object. Narrow with `instanceof`:

```ts
import { ProblemError } from '@spinajs/client/runtime';

const { error } = useUsersGet({ id: 7 });
if (error instanceof ProblemError && error.status === 404) return notFound();
```

React Query types `error` as `Error` unless told otherwise. The generator does not augment its `Register` interface, because that would replace the app's own. To get the error type everywhere, add it once:

```ts sample
import '@tanstack/react-query';
import type { ProblemError } from '@spinajs/client/runtime';

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: ProblemError | Error;
  }
}
```

## Empty replies

A GET answered with 204 or an empty body resolves to `null` in both libraries: React Query rejects `undefined` as query data, and SWR reads it as "not loaded". A GET that returns `void` is typed `null`.

Any other GET keeps its reply type, so `data` is `UserDto` while a 204 gives `null` at runtime. Null-check `data` for a route that can answer empty. The same gap exists for the stream hooks of a socket: the generator refuses a payload type that allows `null`, because `null` turns the hook off, but its check does not see `{}` behind a `$ref`, `not`, `if`/`then`/`else`, or a `$ref` with a sibling `type: 'null'`. Keep `null` out of those payloads yourself.

A mutation that answers 204 resolves to `undefined`, after its invalidation.

## Server rendering

The query hooks only read a cache, so a server can fill it first. With React Query, prefetch with `appQueries` and a per-request `createServerAppClient`, then `dehydrate` and `HydrationBoundary`. With SWR, give `SWRConfig` a `fallback`. [Server rendering and prefetching](ssr.md) has both recipes and the Next.js adapter. Three points concern hooks:

- **Key an SWR fallback with `unstable_serialize`.** The hook keys are arrays, and SWR looks a fallback up by the serialized key. An entry under the array itself is never found. A `useSWRInfinite` hook reads its fallback under the key that `unstable_serialize` from `swr/infinite` builds.

```ts sample
import { unstable_serialize } from 'swr';

const key = unstable_serialize(['spinajs', 'users', 'get', { id: 7 }]);
const fallback: Record<string, unknown> = { [key]: { id: 7 } };
```

- **Credentials stay out of shared caches.** With a `cookie` or `authorization` header present, `createNextServerAppClient` sends the request with `cache: 'no-store'` and no tags. Never let a page rendered with credentials be stored by a shared cache, such as a CDN. For a mutation called from a route handler, forward the browser's `origin` so the CSRF guard can judge it ([details](ssr.md#mutations-from-route-handlers)).
- **Next 16 and Turbopack.** The generated files import each other as `./client.js`, which Turbopack cannot resolve to `client.ts`. Build with `next build --webpack` until the import-extension option lands ([details](ssr.md#nextjs-app-router)).

## Cache buster

`clientShapeHash` in `client.keys.ts` is a hash of every route name, argument name and reply schema. It changes when the shape of the client changes, and not for other manifest edits. Use it as the buster of a persisted query cache, so data stored by an older build is dropped instead of being read as the new types:

```ts
persistQueryClient({ queryClient, persister, buster: clientShapeHash });
```

## Infinite queries

A GET route that returns the `@spinajs/http` `Page<T>` or `CursorPage<T>`, and has a page parameter, gets an infinite hook next to its plain one: `use<Controller><Handler>Infinite`. The compiler records both in the route's `pagination` field ([Paginated replies](../http/10-responses.md#paginated-replies)). A page without a page parameter gets only the plain hook, and `spinajs doctor` warns about it with `HTTP007`.

```ts
// UsersController.list(@Query() query: ListQuery & PageQuery): Promise<Ok<Page<UserDto>>>
const users = useUsersListInfinite({ query: { search: 'an', pageSize: 20 } });
users.data?.pages.flatMap((page) => page.items); // UserDto[]
await users.fetchNextPage();
```

- **Variables.** The same object as the plain hook's, without the page parameter: the hook sets it for each page. Passing `page` (or `cursor`) is a type error. Here `query` is `Omit<ListQuery & PageQuery, 'page'>`, and a value argument `@Query() cursor` is left out of the variables.
- **First page.** An offset route starts at the first page the compiler read from the page parameter's schema: 1, or 0 for a schema that starts at 0. A cursor route starts with no cursor.
- **Next page.** An offset route asks for the next page while the items seen so far are fewer than `total` and the last page was not empty. The items are counted, not the page size, so the hook also ends when the server sends fewer items than `pageSize` asked for. A cursor route asks for the next page while `next` is not `null`.
- **Empty reply.** A page the server leaves out (a 204, as a handler typed `Page<T> | undefined` may send) becomes an empty page, `{ items: [], total: 0 }` or `{ items: [], next: null }`, and ends the data.
- **Keys.** `appKeys.<controller>.<handler>Infinite(vars)` is `[prefix, controller, handler, 'infinite', vars]`. It sits under the controller's key, so a mutation's default invalidation (`appKeys.<controller>.all`) reaches it, and under the route's own `[prefix, controller, handler]`. It never equals the plain key.

### React Query

`useUsersListInfinite(vars, options?)` runs `useInfiniteQuery` over `appQueries.users.listInfinite(client, vars)`, an `infiniteQueryOptions` with `initialPageParam` and `getNextPageParam` set. The options are those of `useInfiniteQuery` without `queryKey`, `queryFn`, `initialPageParam` and `getNextPageParam` (`InfiniteQueryOpts`). A server prefetches with the factory:

```ts
await queryClient.prefetchInfiniteQuery(appQueries.users.listInfinite(serverClient, { query: {} }));
```

`data` is `InfiniteData<Page, number>` for an offset route and `InfiniteData<Page, string | null>` for a cursor route. A mutation's invalidation refetches every loaded page, in order.

### SWR

`useUsersListInfinite(vars | null, config?)` runs `useSWRInfinite`. `null` fetches nothing, and `config` is SWR's infinite configuration (`initialSize`, `revalidateFirstPage`, and so on) without `parallel`: each page key is computed from the page before it, so the hook always fetches in order. Each page is cached under `[...appKeys.users.listInfinite(vars), page]`. `data` is the array of pages, and `setSize` loads more:

```ts
const users = useUsersListInfinite({ query: {} });
await users.setSize(users.size + 1); // asks for no page past `total`, or past `next: null`
```

A mutation revalidates the generated infinite hooks under its `invalidate` prefixes too, and every loaded page refetches. SWR's own `mutate(filter)` skips infinite entries, so the generated mutation drops the cached pages under the prefixes and then revalidates each infinite entry. As with plain keys, only mounted hooks refetch; an unmounted one loads its pages again when it mounts.

- **Your own `useSWRInfinite`.** A hook you write yourself with page keys under the same prefix gets only SWR's own refresh of an infinite entry: its first page (none with `revalidateFirstPage: false`), so its later pages can miss or repeat items. Revalidate it with its own bound `mutate()`, or give its page keys `'infinite'` at index 3, as the generated keys have, so the mutation drops its pages too.
- **SWR versions.** The invalidation relies on two things inside `swr/infinite`: each page is cached under its own key, and a page missing from the cache is fetched again when the infinite entry revalidates. Both are verified on swr 2.2.0 and 2.5.1. A newer swr is covered once the workspace lock is bumped and the e2e (`test/infinite.e2e.test.ts`) passes on it. If a release changes either, the fallback is a per-controller registry of the infinite hooks' own `mutate` functions.
