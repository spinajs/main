---
"@spinajs/client": minor
---

`generateClientFiles(options)` is new: it builds one `ClientModel` from the manifest (`buildClientModel`, also exported) and returns `client.ts` plus the companion files the options request, as `{ path, contents }` pairs named after `basename` (default `client`). Its options extend `GenerateClientOptions` with `hooks`, `zod`, `models`, `socketHooks` and `keyPrefix`. No companion emitter has landed yet, so those options write no file. When `hooks` or `zod` is requested, `client.ts` also exports `manifestHash`, which companion files will check at compile time. Without them, `generateClientFiles({ manifest })` returns exactly the `client.ts` that `generateClient` writes, and that output is unchanged.

`@spinajs/client/formats` is reserved as an empty subpath. `zod ^4.1.0`, `@tanstack/react-query ^5.0.0`, `swr ^2.1.0` and `react ^18.0.0 || ^19.0.0` are optional peers: only generated companion files import them. A dependency-cruiser rule keeps `@spinajs/client/runtime` and `/formats` free of imports from outside their own folder.
