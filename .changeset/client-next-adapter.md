---
"@spinajs/client": minor
---

`ClientOptions.init(route)` is a new, optional option. It is called before every request with `{ controller, name, method }`, and what it returns is merged into the fetch options after the client's own. `method`, `headers` and `body` stay the client's, and members `fetch` does not know, such as Next.js's `next`, pass through. `createServerAppClient` takes it too.

`generateClientFiles({ next: true })` writes `client.next.ts`, together with `client.server.ts` and `client.keys.ts`. The file is server-safe and imports no Next type, only `revalidateTag` and `updateTag` from `next/cache`. `next >=16.0.0` is a new optional peer.

- `createNextServerAppClient(options)` is `createServerAppClient` with a `revalidate` option. A GET query route without user credentials is sent with `next: { tags: ['spinajs:<controller>', 'spinajs:<controller>:<handler>'], revalidate }`. Any request that carries a `cookie` or `authorization` header goes out with `cache: 'no-store'` and no tags, so personal replies never enter Next's shared cache.
- `nextCacheInit({ revalidate })` is the tagging `init` on its own, for clients that never send user credentials.
- `revalidateController(name, profile = 'max')`, `revalidateRoute(controller, route, profile = 'max')` and `updateController(name)` call `revalidateTag` and `updateTag` with the same tags, for Server Actions and route handlers after a mutation. The tags come from `appTags`, so they follow `keyPrefix`.

`next` is a new generator target. Without it, nothing changes. `docs/client/ssr.md` covers the adapter. It notes that Next 16 resolves the generated `./client.js` imports only in a webpack build with `experimental.extensionAlias`. It also describes the App Router fixture in `fixtures/next-app/`, which runs in its own CI workflow.
