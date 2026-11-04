---
"@spinajs/client": minor
---

`generateClientFiles({ hooks })` now writes the module that the React Query and SWR hooks share, once, whichever libraries are requested:

- `client.keys.ts` (server-safe: no React, no query library). It exports `appKeys`, `appTags`, `AppClientError = ProblemError | Error` and `clientShapeHash`. A query key is `[prefix, controllerKey, handler, vars]`, and `vars` is `{}` for a route without arguments. A mutation key is `[prefix, controllerKey, handler]`, and `appKeys.<controller>.all` is the prefix of every key of a controller. The prefix is `'spinajs'` unless `keyPrefix` says otherwise. Tags are `<prefix>:<controllerKey>` and `<prefix>:<controllerKey>:<handler>`, for GET routes only. `clientShapeHash` changes only with a route name, an argument name or a reply schema, so it can bust a persisted cache.
- `client.react.ts` (first statement `'use client'`). It exports `AppClientProvider` and `useAppClient`, written with `createElement`, so apps need no JSX setting for generated code.

GET routes get a query, POST, PUT, PATCH and DELETE routes a mutation, and HEAD and file routes no hook. Hook variables are one object keyed by argument name, so reordering a handler's parameters changes no key. A handler or controller that would replace an `all` key is refused. Both files check `manifestHash` at compile time. The React Query and SWR targets themselves are still unavailable.

Each `GeneratedFile` now says whether it is a `client` or a `server-safe` file. Files come back in the target table's order, whatever the order of `hooks`, and two emitters writing the same path is an error. An empty `keyPrefix` is refused. The client keys controllers with `controllerKey` from `@spinajs/manifest`, the rule `manifest:diff` uses. Without `hooks` or `zod`, `client.ts` is unchanged.
