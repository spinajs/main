# Server rendering and prefetching

A server that renders the page (a Next.js Server Component, a Remix or React Router loader, an Express handler calling `renderToString`) can call the API itself, put the answer into the page, and let the browser start with the data instead of fetching it again. `@spinajs/client` covers four parts of that:

- `client.server.ts`, a per-request client that forwards the browser's credentials to the API;
- prefetching with React Query: `appQueries`, `prefetchQuery`, `dehydrate` and `HydrationBoundary`;
- prefetching with SWR: a `fallback` keyed with `unstable_serialize`;
- `client.next.ts`, Next.js cache tags on GET calls and the helpers that revalidate them after a mutation.

## The server client

```ts
import { generateClientFiles } from '@spinajs/client';

const files = await generateClientFiles({ manifest, server: true, hooks: ['react-query'] });
```

`server: true` adds `client.server.ts` next to `client.ts`. It works with or without `hooks`. The file has no `'use client'` and imports neither React nor a query library, only `@spinajs/client/runtime` and `./client.js`, so Server Components, loaders and route handlers can import it.

```ts
import { createServerAppClient } from './generated/client.server.js';

const client = createServerAppClient({ baseUrl: process.env.API_URL!, incoming: request.headers });
const user = await client.users.get(7);
```

> **Never let a shared cache store a page rendered with forwarded credentials.** The HTML and the dehydrated state hold one visitor's data. A CDN or caching proxy that stores them serves user A's page to user B. Send `cache-control: private, no-store` with every response rendered through `createServerAppClient`, or a `Vary` that names every forwarded header and that each cache in front of the app honours. Next.js marks dynamic routes `private, no-store` itself. Loaders, Express handlers and plain Node servers do not. The same holds for Next's `fetch` cache, which lives on the server and is shared by every visitor: a call made with forwarded credentials gets no `revalidate` and no cache tags. `createNextServerAppClient` enforces that ([Next.js cache tags and revalidation](#nextjs-cache-tags-and-revalidation)).

`createServerAppClient(options)` returns the same `AppClient` as `createAppClient`. It takes every `ClientOptions` member except `credentials`, plus:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `string` | required | Absolute `http:` or `https:` URL of the API, without user name or password. Anything else throws `TypeError`: a relative URL has no page origin to resolve against on a server, and `localhost:3000` without a scheme parses as a URL whose scheme is `localhost:`. |
| `incoming` | `Headers \| Record<string, string \| string[] \| undefined> \| { get(name): string \| null }` | none | The headers of the request being served: Next.js `await headers()`, a Fetch API `Request.headers`, or Node's `IncomingMessage.headers`. |
| `forward` | `readonly string[]` | `['cookie', 'authorization']` | Header names copied from `incoming`. The list replaces the default, so name `cookie` again when you add a header. |
| `headers` | `Record<string, string>` or a function returning one (or a promise of one) | none | Extra headers, added after the forwarded ones, so they win over a forwarded header of the same name, whatever its case. |
| `redirect` | `RequestRedirect` | fetch's own (`follow`) | Passed to every `fetch`. `'error'` rejects instead of following a redirect, so forwarded credentials never reach another URL. |

### What is forwarded

`forward` is the control: only the names it lists leave the server, and nothing else is copied from `incoming`. Keep it short.

- **The default sends every cookie of the page's origin and any `Authorization` the frontend received**, not only the API's session cookie. On a navigation that `Authorization` is typically HTTP Basic from a staging gate or an SSO proxy in front of the frontend. So `baseUrl` must be your own API. For any other API, narrow `forward`, or pass the credential it needs in `headers`.
- **`Set-Cookie` from the API is not relayed to the browser.** A session that the API rolls on each request (a refreshed expiry, a rotated id) is refreshed only for the server's call, and the browser keeps its old cookie. Refresh sessions from browser requests, or copy the header to your response yourself.

A blocklist sits behind `forward` as defence in depth. `forward` must not list these names, and a listed one throws `TypeError` when the client is created:

- hop-by-hop headers (RFC 9110 7.6.1): `connection`, `keep-alive`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `proxy-authorization`, `proxy-authenticate`;
- headers that describe or condition the incoming message, which would reshape or break the API call: `host`, `content-length`, `content-type`, `content-encoding`, `expect`, `range`, `accept`, every `if-*`, and `set-cookie`;
- client-address, routing and method headers that an API or its proxy may trust: `forwarded`, every `x-forwarded-*`, `x-real-ip`, `cf-connecting-ip`, `true-client-ip`, `x-client-ip`, `x-original-url`, `x-rewrite-url`, `x-http-method-override`, `x-http-method`, `x-method-override`.

Forwarding a client address would hand the API whatever the browser claimed, together with any trust decision the API bases on it. To pass one on deliberately, set it yourself in `headers` from a value your own proxy vouches for. A header that the incoming `connection` header names is hop-by-hop too, and it is skipped without an error. A name that is not an HTTP token throws, as does a blocked one, whatever the request carries.

The incoming headers are read once, when the client is created. Each value goes through the same check as every other header: a CR, LF or a character beyond Latin-1 throws `TypeError` at creation. A multi-value entry (Node's `string[]`, or an array from a `get()` source) is joined with `; ` for `cookie` and with `, ` for any other header. In a record, the names match case-insensitively, and the first defined value wins.

**Create one client per request.** A client created at module scope would send the first visitor's cookie with everyone's requests.

`Cookie` works here because the request is made by the server: browsers drop a `Cookie` header from `fetch`, server runtimes do not. In Next.js, `await headers()` already carries the `cookie` header, so `cookies()` is only needed by an app that builds the header itself.

### Redirects

By default `fetch` follows redirects, and the forwarded `cookie` and `authorization` go with it. Node 22 and later (undici) drop both on a redirect to another origin. Other server runtimes may not. For an API that never redirects, set `redirect: 'error'`. With a custom `fetch`, the option is applied on top of it.

### Mutations from route handlers

SpinaJS's CSRF guard checks every unsafe request (POST, PUT, PATCH, DELETE) that carries one of the ambient cookies in `http.csrf.ambientCookies`. Without an `Origin` or `Sec-Fetch-Site` it refuses with 403. A server-side fetch sends neither, so a route handler that calls a mutation through `createServerAppClient` with the browser's session cookie gets 403. To let it through:

1. Forward the browser's `Origin`: `forward: ['cookie', 'authorization', 'origin']`.
2. List the frontend's origin in `http.csrf.allowedOrigins` on the API, for example `['https://app.example.com']`.

The guard then judges the browser's own `Origin`, exactly as if the browser had called the API directly. A cross-site form posted to your route handler still carries the attacker's `Origin`, and the API still refuses it.

**Never relax the guard for the SSR server.** Do not disable `http.csrf`, exempt the routes, or drop the session cookie from `ambientCookies` to make server calls pass. Any of those turns the SSR server into a CSRF relay: a forged cross-site post to the frontend would reach the API with the victim's cookie and no origin check. Next.js Server Actions check the origin before they run, but Next route handlers and other frameworks' actions do not.

The runtime helpers behind the file are exported from `@spinajs/client/runtime` for hand-written clients: `forwardedHeaders(incoming, names)` returns the forwarded headers as a lower-cased record, and `serverClientOptions(options)` turns the options above into client options. Options it does not know about are kept, in the types too.

## React Query

Generate with `hooks: ['react-query']` and `server: true`. On the server, import `appQueries` from `client.queries.ts` and never from `client.react-query.ts`. The hooks file starts with `'use client'`, so a Server Component that imports it gets client references instead of functions.

### Next.js App Router

```tsx
// app/users/[id]/page.tsx: a Server Component
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { headers } from 'next/headers';
import { createServerAppClient } from '@/generated/client.server';
import { appQueries } from '@/generated/client.queries';
import { UserCard } from './user-card';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const client = createServerAppClient({ baseUrl: process.env.API_URL!, incoming: await headers() });
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(appQueries.users.get(client, { id }));
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UserCard id={id} />
    </HydrationBoundary>
  );
}
```

```tsx
// app/users/[id]/user-card.tsx
'use client';
import { useUsersGet } from '@/generated/client.react-query';

export function UserCard({ id }: { id: number }) {
  const { data } = useUsersGet({ id });
  return <p>{data?.email}</p>;
}
```

```tsx
// app/providers.tsx, rendered by the root layout
'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { createAppClient } from '@/generated/client';
import { AppClientProvider } from '@/generated/client.react';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } }));
  const [client] = useState(() => createAppClient({ baseUrl: process.env.NEXT_PUBLIC_API_URL!, credentials: 'include' }));
  return (
    <QueryClientProvider client={queryClient}>
      <AppClientProvider client={client}>{children}</AppClientProvider>
    </QueryClientProvider>
  );
}
```

- `appQueries.<controller>.<handler>(client, vars)` builds the same key as the hook does with the same variables, `appKeys.users.get({ id })`. That shared key is what lets `HydrationBoundary` hand the server's answer to `useUsersGet({ id })`.
- Create a `QueryClient` per request on the server, as for the server client.
- **Give the browser's `QueryClient` a `staleTime` above 0.** With React Query's default of 0, the hydrated data is stale as soon as it arrives, and `useUsersGet` fetches it again on mount. React Query's own SSR guide recommends this too.
- `prefetchQuery` never throws. A failed call leaves the query out of the dehydrated state, and the browser fetches it. Use `fetchQuery` when the page should fail instead.
- The dehydrated state is plain JSON when the replies are: generated DTOs are interfaces over the JSON the server sent, so they cross the Server Component boundary as they are.

### Without a framework

`IncomingMessage.headers` is a record, so a Node server passes it as it is:

```ts
import { createServer } from 'node:http';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { dehydrate, HydrationBoundary, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServerAppClient } from './generated/client.server.js';
import { appQueries } from './generated/client.queries.js';
import { AppClientProvider } from './generated/client.react.js';
import { UserCard } from './user-card.js';

createServer(async (req, res) => {
  const client = createServerAppClient({ baseUrl: 'http://api.internal:8080', incoming: req.headers });
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(appQueries.users.get(client, { id: 7 }));
  const state = dehydrate(queryClient);
  const html = renderToString(
    createElement(QueryClientProvider, { client: new QueryClient() },
      createElement(HydrationBoundary, { state },
        createElement(AppClientProvider, { client }, createElement(UserCard, { id: 7 })))),
  );
  res.setHeader('content-type', 'text/html');
  // The page holds this visitor's data: no shared cache may store it.
  res.setHeader('cache-control', 'private, no-store');
  // Escape `<` so that a reply containing `</script>` cannot end the script element.
  res.end(`<div id="root">${html}</div><script>window.__STATE__ = ${JSON.stringify(state).replace(/</g, '\\u003c')}</script>`);
}).listen(3000);
```

In the browser, `hydrateRoot` renders the same tree with a new `QueryClient` (with a `staleTime`), a browser client from `createAppClient`, and `window.__STATE__` as the `HydrationBoundary` state.

## SWR

Generate with `hooks: ['swr']` and `server: true`. Seed SWR's `fallback` on the server and pass it to `SWRConfig`:

```tsx
// app/users/[id]/page.tsx: a Server Component
import { SWRConfig, unstable_serialize } from 'swr';
import { headers } from 'next/headers';
import { createServerAppClient } from '@/generated/client.server';
import { appKeys } from '@/generated/client.keys';
import { UserCard } from './user-card'; // 'use client', calls useUsersGet({ id }) from client.swr

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  const client = createServerAppClient({ baseUrl: process.env.API_URL!, incoming: await headers() });
  const fallback = { [unstable_serialize(appKeys.users.get({ id }))]: await client.users.get(id) };
  return (
    <SWRConfig value={{ fallback, revalidateIfStale: false }}>
      <UserCard id={id} />
    </SWRConfig>
  );
}
```

- **Key the fallback with `unstable_serialize(appKeys.<controller>.<handler>(vars))`.** The generated hooks use array keys, and SWR looks a fallback up by the serialized key. An entry under the array itself, or under `String(key)`, is never found, and the hook fetches.
- With SWR's defaults, a hook revalidates fallback data on mount, which is one request per hook. `revalidateIfStale: false` keeps the fallback until something else revalidates it (focus, reconnect, a mutation). Set it in this `SWRConfig` only, or per hook through the hook's configuration argument. `revalidateOnMount: true`, set anywhere, overrides it and refetches.
- `appKeys` comes from `client.keys.ts`, which imports neither React nor SWR. Never import it from `client.swr.ts` on the server.
- `unstable_serialize` can be imported in a Server Component from SWR 2.2.0, but `SWRConfig` only from **2.3.0**. With SWR 2.2.x, put `SWRConfig` in a small `'use client'` component that takes `fallback` as a prop.
- **On the server, never call SWR's `preload` or the global `mutate` with the server client.** SWR's default cache and its `preload` store live at module scope, so on a server they are shared by every request in the process, and one visitor's data would reach the next. `fallback` is safe, because SWR never writes it into that cache.
- A `useSWRInfinite` hook reads its fallback under the key that `unstable_serialize` from `swr/infinite` builds, not the one from `swr`.

## Next.js cache tags and revalidation

```ts
const files = await generateClientFiles({ manifest, next: true, hooks: ['react-query'] });
```

`next: true` writes `client.next.ts`, and with it `client.server.ts` and `client.keys.ts`, so it needs neither `server` nor `hooks`. The file is server-safe: no `'use client'`, no React. It calls `revalidateTag` and `updateTag` from `next/cache` and imports no Next type: the `next` fetch option is typed structurally. `@spinajs/client` lists `next >=16.0.0` as an optional peer. Next 16 made the second argument of `revalidateTag` required, so the helpers do not type-check against Next 15.

| Export | What it does |
| --- | --- |
| `createNextServerAppClient(options)` | `createServerAppClient` on Next's cache. Takes the server client's options plus `revalidate`. A GET without user credentials is tagged and cached; a call with credentials is sent uncached. |
| `nextCacheInit({ revalidate? })` | The `init` behind it: tags each GET query route, nothing else. It cannot see the request's headers, so use it only on a client that never sends user credentials. |
| `revalidateController(name, profile = 'max')` | `revalidateTag('<prefix>:<controller>', profile)`: every cached GET of the controller. |
| `revalidateRoute(controller, route, profile = 'max')` | `revalidateTag('<prefix>:<controller>:<handler>', profile)`: one GET route, under every set of arguments. |
| `updateController(name)` | `updateTag('<prefix>:<controller>')`, in a Server Action only: expires the tag, so the render that follows the action reads fresh data. |

```tsx
// app/users/page.tsx: a Server Component
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { headers } from 'next/headers';
import { createNextServerAppClient } from '@/generated/client.next';
import { appQueries } from '@/generated/client.queries';
import { createUser } from './actions';
import { UsersList } from './users-list';

export default async function Page() {
  const client = createNextServerAppClient({ baseUrl: process.env.API_URL!, incoming: await headers(), revalidate: 3600 });
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(appQueries.users.list(client, { query: {} }));
  return (
    <>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <UsersList />
      </HydrationBoundary>
      <form action={createUser}>
        <input name="email" type="email" />
        <button type="submit">Add</button>
      </form>
    </>
  );
}
```

```ts
// app/users/actions.ts
'use server';
import { headers } from 'next/headers';
import { DEFAULT_FORWARDED_HEADERS } from '@spinajs/client/runtime';
import { revalidateController } from '@/generated/client.next';
import { createServerAppClient } from '@/generated/client.server';

export async function createUser(form: FormData): Promise<void> {
  const client = createServerAppClient({ baseUrl: process.env.API_URL!, incoming: await headers(), forward: [...DEFAULT_FORWARDED_HEADERS, 'origin'] });
  await client.users.create({ email: String(form.get('email')) });
  revalidateController('users');
}
```

- **Tags.** A GET query route gets two tags, `<prefix>:<controller>` and `<prefix>:<controller>:<handler>`: the `appTags` of `client.keys.ts`. The prefix is `keyPrefix`, `spinajs` by default. Tags never carry arguments. Next limits their length and number, and a tag per argument set could not be revalidated as a whole. POST, PUT, PATCH, DELETE, HEAD and file routes get no tag and no `revalidate`.
- **`revalidate`** is the number of seconds Next keeps a tagged reply, or `false` to keep it until a tag is revalidated. Next 16 caches no `fetch` by default, so tags alone change nothing until the call opts in: `revalidate`, `cache: 'force-cache'`, or the segment's `fetchCache`.
- **Credentials are never cached.** `createNextServerAppClient` checks each request just before `fetch`. A request with a `cookie` or `authorization` header, forwarded or added through `headers`, goes out with `cache: 'no-store'` and without tags or `revalidate`.
  - Next 16 keys its cache by the request headers too, so a visitor with another cookie misses such an entry. The entry would still hold one visitor's data in a cache that every server instance shares, for as long as `revalidate` says.
  - A page that renders both public and personal data uses one client for each.
  - If every visitor's calls carry the same service token, opt in with `createServerAppClient({ ..., init: nextCacheInit({ revalidate }) })`.
- **`'max'` is stale-while-revalidate.** After `revalidateController('users')`, the next request still gets the old reply while Next refetches in the background, and the request after it gets the new one. For read-your-writes in the action itself, call `updateController('users')`, or pass `{ expire: 0 }` as the profile.
- **Server Actions and the CSRF guard.** The action above runs with the visitor's cookie, so the API's guard checks its `Origin` (see [Mutations from route handlers](#mutations-from-route-handlers)). Next compares the action's `Origin` with its own host before the action runs, so forwarding `origin` passes on a checked value. List the frontend's origin in `http.csrf.allowedOrigins`.
- **Bundling.** The generated files import each other as `./client.js`, the specifier that Node's ESM resolution needs. Next 16.4 maps it to `client.ts` only in its webpack build, with `experimental.extensionAlias`. Turbopack, the default bundler of Next 16, ignores that option, so build with `next build --webpack` and this `next.config.mjs`:

  ```js
  export default { experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } } };
  ```

### The App Router fixture

`fixtures/next-app/` is a Next.js 16 app that runs the code above against app-basic. It sits outside the workspaces, with its own `package.json` and lockfile, so the root `npm ci` never installs Next. Its `e2e` script generates the client from app-basic's manifest, boots app-basic with a request counter, builds and starts the app, and checks with `fetch` that:

- the page renders the fixture user, fetched on the server;
- a second render is served from Next's cache, so the counter does not move;
- a request with a cookie is fetched every time and leaves the cached entry alone;
- the Server Action creates a user through the CSRF guard, and after `revalidateController('users')` the page refetches once and shows the new user.

The layout, a Server Component, imports `AppClientProvider`, so a `client.react.ts` without `'use client'` fails `next build`. CI runs the fixture in the `next-fixture` workflow. To run it locally, after `npm ci` and `npm run build` at the repository root:

```sh
cd fixtures/next-app
npm ci
npm run e2e
```

## ckit

ckit's `HydrateDataSource` hydrates from its own `DataSeed`. It reads neither TanStack's dehydrated state nor SWR's `fallback`, so the prefetching above does not seed a ckit data source. A page that renders a ckit grid builds the seed for it with ckit's own helpers. The generator writes no ckit adapter.
