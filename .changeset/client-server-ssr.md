---
"@spinajs/client": minor
---

`generateClientFiles({ server: true })` writes `client.server.ts` next to `client.ts`, with `createServerAppClient(options)` for Server Components, loaders and route handlers. The file has no `'use client'` and imports neither React nor a query library, and it needs no `hooks`.

- `baseUrl` must be an absolute `http:` or `https:` URL without credentials; anything else throws `TypeError`.
- `incoming` takes the headers of the request being served: a `Headers` (Next.js `await headers()`), a record such as Node's `req.headers`, or anything with `get(name)`. Only the names in `forward` are copied, by default `cookie` and `authorization`. A header the incoming `connection` header names is skipped.
- As defence in depth, `forward` must not list hop-by-hop headers, the incoming message's own `host`, `content-length`, `content-type`, `content-encoding`, `expect`, `range`, `accept`, `if-*` and `set-cookie`, or client-address and routing headers (`forwarded`, `x-forwarded-*`, `x-real-ip`, `cf-connecting-ip`, `true-client-ip`, `x-client-ip`, `x-original-url`, `x-rewrite-url`, and the method-override headers). Such a name, or one that is not an HTTP token, throws `TypeError` when the client is created.
- `headers` adds headers after the forwarded ones. `redirect` is passed to every fetch (`'error'` keeps forwarded credentials from following a redirect). `credentials` is not an option.

`@spinajs/client/runtime` exports the helpers behind it: `forwardedHeaders(incoming, names)`, `serverClientOptions(options)`, `DEFAULT_FORWARDED_HEADERS`, and the `IncomingHeaders` and `ServerClientOptions` types. `server` is a new generator target. Without it, nothing changes.

`docs/client/ssr.md` covers prefetching with React Query (`appQueries`, `prefetchQuery`, `dehydrate`, `HydrationBoundary`) and SWR (`fallback` keyed with `unstable_serialize`), in the Next.js App Router and without a framework. It also covers keeping such pages out of shared caches, and mutations from route handlers through the CSRF guard: forward `origin` and list the frontend in `http.csrf.allowedOrigins`.
