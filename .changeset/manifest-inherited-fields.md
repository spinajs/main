---
"@spinajs/manifest": minor
"@spinajs/http-socket": patch
---

New optional manifest fields record inheritance: `ControllerEntry.bases` and `SocketControllerEntry.bases` (ancestor entry ids, nearest first), `inheritedFrom` on routes, socket commands and events, and `payloadIndex` on socket commands and events. Socket events get an optional `handler` (the method that handles the event, exported as the `SocketEventEntry` type), and `Manifest.compilerVersion` can name the `@spinajs/compiler` version that built the manifest. `inheritController` and `inheritSocketHandlers` apply the runtime's inheritance rules to manifest entries; `@spinajs/http-socket` now resolves inherited handlers through `inheritSocketHandlers`. `MANIFEST_VERSION` stays 2, and a manifest without inheritance is unchanged.
