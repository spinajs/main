---
"@spinajs/client": minor
---

`generateClientFiles(options)` is new. It builds one `ClientModel` from the manifest (`buildClientModel(manifest, { includeSocket? })`, also exported) and returns `client.ts` plus the companion files the options request. Each file comes back as a `{ path, contents }` pair, named after `basename` (default `client`).

The model is complete once it is built: it holds every schema the client and its socket contracts reach, and printing adds none. Every target therefore prints from the same schema set, and one model can be printed more than once.

The options extend `GenerateClientOptions` with `hooks`, `zod`, `models`, `socketHooks` and `keyPrefix`. No companion emitter has landed yet, so those options write no file. `GENERATOR_TARGETS` says which targets are available, and `requestedTargets(options)` names the targets a set of options asks for. An unknown or repeated `hooks` target is refused, and so is `socketHooks` without `hooks`. When `hooks` or `zod` is requested, `client.ts` also exports `manifestHash`, which companion files will check at compile time. Without them, `generateClientFiles({ manifest })` returns exactly the `client.ts` that `generateClient` writes, and that output is unchanged.

`@spinajs/client/formats` is reserved as an empty subpath. `zod ^4.1.0`, `@tanstack/react-query ^5.0.0`, `swr ^2.1.0` and `react ^18.0.0 || ^19.0.0` are optional peers: only generated companion files import them. dependency-cruiser rules keep `@spinajs/client/runtime` free of imports from outside itself and `/formats`, and keep `/formats` free of imports from outside its own folder.
