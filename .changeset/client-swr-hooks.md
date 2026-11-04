---
"@spinajs/client": minor
---

`generateClientFiles({ hooks: ['swr'] })` writes `client.swr.ts`, which starts with `'use client'`: a `useSWR` hook per GET route and a `useSWRMutation` hook per POST, PUT, PATCH and DELETE route, named `use<Controller><Handler>`.

- A query hook takes the variables object as `vars | null`. `null` is SWR's conditional fetch; a route whose arguments are all optional also accepts nothing or `{}`. The SWR configuration is the second parameter.
- A mutation hook revalidates every key of its own controller (`appKeys.<controller>.all`) after the call succeeds, and stays pending until the refetch settles. A key under several of the prefixes refetches once. `MutationConfig` and `MutationResult` are exported from `client.swr.ts`. `invalidate: false` revalidates nothing, and `invalidate: [appKeys.users.get({ id: 7 }), …]` replaces the default with key prefixes. The match compares SWR's own key hash, so a prefix may include variables.
- Seed SWR's `fallback` with `unstable_serialize(appKeys.users.get({ id }))`: array keys do not match by themselves.
- Without `swr` in `hooks`, nothing changes. `swr` is now an available generator target.

The `swr` peer range of `@spinajs/client` is now `^2.2.0`, because the generated mutation types use the generic order that SWR 2.2.0 introduced. A React 19 app needs SWR 2.3.0 or later, the first release whose own peer range names React 19.
