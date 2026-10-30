---
"@spinajs/http-socket": minor
"@spinajs/http-socket-common": minor
"@spinajs/manifest": minor
"@spinajs/compiler": minor
---

Server-enforced socket contracts. `@SocketController(prefix, { contract })` binds a controller to a `defineContract<C>(id?)` contract. With `system.manifest.mode` `prefer` or `require`, `SocketHandlerRegistry.build()` checks the registered handlers against `manifest.socketContracts` (`require` fails the build, `prefer` logs a warning) and incoming payloads are validated with Ajv against the contract schemas (no coercion; `x-*` keys stripped; schemas marked `x-explicit: 'partial'` are skipped). A payload that does not match is refused with `invalid_argument` and `details.errors`. With `mode: 'off'`, or without a manifest in `prefer`, nothing changes on the wire. The manifest records the bound contract in `SocketControllerEntry.contract` (additive), `checkSocketContract` is exported from `@spinajs/manifest`, and `spinajs doctor` gains `SOCK001` (handler missing), `SOCK002` (payload mismatch) and `SOCK003` (result mismatch).

Contracts fail closed per mode: a schema that cannot compile (an unresolved `$ref`) fails `require` boot naming the contract and the ref, and skips only that contract in `prefer`; controllers are matched to their manifest entry by class name and prefix (ambiguity is an error); the manifest binding is authoritative in `require`, including for a controller whose code declares no contract; a contract imported from a dependency resolves through that package's manifest fragment (`SocketContractEntry.exportName`, additive); duplicate contract ids are `SOCK005`; `details.errors` is capped at 10 with a `total`; `format` keywords are enforced (`ajv-formats`).
