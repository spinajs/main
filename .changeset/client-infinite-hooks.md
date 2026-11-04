---
"@spinajs/client": minor
"@spinajs/compiler": minor
---

A GET route that the manifest marks paginated (`RouteEntry.pagination`) and that has a page parameter gets an infinite query next to its plain one.

- `client.keys.ts`: `appKeys.<controller>.<handler>Infinite(vars)`, the key `[prefix, controller, handler, 'infinite', vars]`. It sits under the controller key, so a mutation's default invalidation reaches it, and it never equals the plain key.
- `client.queries.ts`: `appQueries.<controller>.<handler>Infinite(client, vars)`, an `infiniteQueryOptions` with `initialPageParam` (the route's first page, 0 or 1, or `null` for a cursor) and `getNextPageParam`. An offset route counts the items seen against `total`, so a server that clamps the page size still pages to the end. A cursor route follows `next` until it is `null`.
- `client.react-query.ts`: `use<Controller><Handler>Infinite(vars, options?)` over `useInfiniteQuery`, with the exported `InfiniteQueryOpts`.
- `client.swr.ts`: `use<Controller><Handler>Infinite(vars | null, config?)` over `useSWRInfinite`, which asks for no page past `total` or past `next: null`. `config` (`InfiniteConfig`) leaves out `parallel`, which the hook turns off. When the manifest has a paginated route, the mutation hooks also revalidate the generated infinite hooks under their `invalidate` prefixes, and every loaded page refetches; SWR's `mutate(filter)` alone skips them. An app's own `useSWRInfinite` under the same prefix gets only SWR's first-page refresh. This relies on how `swr/infinite` caches pages, verified on swr 2.2.0 and 2.5.1; a newer swr needs the lock bumped and the e2e rerun, and a per-controller registry of the hooks' `mutate` functions is the fallback.
- An empty reply (a 204) on an infinite route is an empty page and ends the data, in both libraries.
- The variables leave the page parameter out: the property of a query object becomes `Omit<…, 'page'>`, and a value argument is dropped. `RouteModel.pagination` (`PaginationModel`) records where the parameter travels.
- A handler named `<handler>Infinite` next to a paginated `<handler>` is refused, because both would be the same hook.

Without a paginated route, every generated file is unchanged.

The compiler marks an interface that extends `Page<T>` or `CursorPage<T>`, and an optional page (`Promise<Page<T> | undefined>`), as paginated. A union reply on an abstract base warns `HTTP007` once per subclass that serves it, not on the base as well.
