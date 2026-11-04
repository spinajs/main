---
"@spinajs/client": minor
---

`generateClientFiles({ server: true })` writes `client.server.ts` next to `client.ts`, with `createServerAppClient(options)` for Server Components, loaders and route handlers. The file has no `'use client'` and imports neither React nor a query library, and it needs no `hooks`.

- `baseUrl` must be absolute: a relative URL throws `TypeError`.
- `incoming` takes the headers of the request being served: a `Headers` (Next.js `await headers()`), a record such as Node's `req.headers`, or anything with `get(name)`. Only the names in `forward` are copied, by default `cookie` and `authorization`. `host`, `content-length`, `set-cookie`, hop-by-hop headers (including any the incoming `connection` header names), `forwarded`, `x-real-ip` and every `x-forwarded-*` are never forwarded, whatever `forward` lists.
- `headers` adds headers after the forwarded ones. `credentials` is not an option.

`@spinajs/client/runtime` exports the helpers behind it: `forwardedHeaders(incoming, names)`, `serverClientOptions(options)`, `DEFAULT_FORWARDED_HEADERS`, and the `IncomingHeaders` and `ServerClientOptions` types. `server` is a new generator target. Without it, nothing changes.

`docs/client/ssr.md` covers prefetching with React Query (`appQueries`, `prefetchQuery`, `dehydrate`, `HydrationBoundary`) and SWR (`fallback` keyed with `unstable_serialize`), in the Next.js App Router and without a framework.
