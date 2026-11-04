# Hooks

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
