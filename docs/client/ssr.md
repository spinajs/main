# Server rendering and prefetching

A server that renders the page (a Next.js Server Component, a Remix or React Router loader, an Express handler calling `renderToString`) can call the API itself, put the answer into the page, and let the browser start with the data instead of fetching it again. `@spinajs/client` covers three parts of that:

- `client.server.ts`, a per-request client that forwards the browser's credentials to the API;
- prefetching with React Query: `appQueries`, `prefetchQuery`, `dehydrate` and `HydrationBoundary`;
- prefetching with SWR: a `fallback` keyed with `unstable_serialize`.

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

`createServerAppClient(options)` returns the same `AppClient` as `createAppClient`. It takes every `ClientOptions` member except `credentials`, plus:

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `string` | required | Absolute URL of the API. A relative URL throws `TypeError`, because a server has no page origin to resolve it against. |
| `incoming` | `Headers \| Record<string, string \| string[] \| undefined> \| { get(name): string \| null }` | none | The headers of the request being served: Next.js `await headers()`, a Fetch API `Request.headers`, or Node's `IncomingMessage.headers`. |
| `forward` | `readonly string[]` | `['cookie', 'authorization']` | Header names copied from `incoming`. The list replaces the default, so name `cookie` again when you add a header. |
| `headers` | `Record<string, string>` or a function returning one (or a promise of one) | none | Extra headers, added after the forwarded ones, so they win over a forwarded header of the same name. |

Some headers are never forwarded, whatever `forward` lists:

- `host`, `content-length` and `set-cookie`;
- hop-by-hop headers: `connection`, `keep-alive`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `proxy-authorization`, `proxy-authenticate`, and any header that the incoming `connection` header names;
- the proxy headers `forwarded`, `x-real-ip` and every `x-forwarded-*`.

Forwarding those would hand the browser's host and client address to the API, and with them any trust decision the API bases on them. To pass a client address on deliberately, set it yourself in `headers`.

The incoming headers are read once, when the client is created, and each value goes through the same check as every other header: a CR, LF or a character beyond Latin-1 throws `TypeError` at creation. A multi-value record entry (Node's `string[]`) is joined with `; ` for `cookie` and with `, ` for any other header. Create one client per request. A client created at module scope would send the first visitor's cookie with everyone's requests.

`Cookie` works here because the request is made by the server: browsers drop a `Cookie` header from `fetch`, server runtimes do not. In Next.js, `await headers()` already carries the `cookie` header, so `cookies()` is only needed by an app that builds the header itself.

The runtime helpers behind the file are exported from `@spinajs/client/runtime` for hand-written clients: `forwardedHeaders(incoming, names)` returns the forwarded headers as a lower-cased record, and `serverClientOptions(options)` turns the options above into `ClientOptions`.

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
- With SWR's defaults, a hook revalidates fallback data on mount, which is one request per hook. `revalidateIfStale: false` keeps the fallback until something else revalidates it (focus, reconnect, a mutation). Set it in this `SWRConfig` only, or per hook through the hook's configuration argument.
- `appKeys` comes from `client.keys.ts`, which imports neither React nor SWR. Never import it from `client.swr.ts` on the server.
- `unstable_serialize` can be imported in a Server Component from SWR 2.2.0, but `SWRConfig` only from **2.3.0**. With SWR 2.2.x, put `SWRConfig` in a small `'use client'` component that takes `fallback` as a prop.

## ckit

ckit's `HydrateDataSource` hydrates from its own `DataSeed`. It reads neither TanStack's dehydrated state nor SWR's `fallback`, so the prefetching above does not seed a ckit data source. A page that renders a ckit grid builds the seed for it with ckit's own helpers. The generator writes no ckit adapter.
