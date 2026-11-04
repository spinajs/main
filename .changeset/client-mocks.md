---
"@spinajs/client": minor
---

`generateClientFiles({ manifest, mocks: true })` now also writes `client.mocks.ts`. It holds `mock<Dto>(overrides?, options?)` for every schema `client.ts` declares, `mockPage` and `mockCursorPage`, and `createMockAppClient(impl, { fallback?, seed? })`, a typed `AppClient` with no network, all on top of `@spinajs/client/mocks`. Every mock passes the server's validation of its DTO; a property test checks this on the app-basic and schema-corpus fixtures and on a synthetic corpus. A schema the sampler cannot honour gets diagnostic `MOCK001` on the file, and its mock throws `MockUnsupported`. No other generated file imports `client.mocks.ts`. `emitMocks(model)` prints the file from a `ClientModel`, the `mocks` target is added to `GENERATOR_TARGETS`, and `GeneratorDiagnosticCode` gains `MOCK001`. Without `mocks`, `client.ts` is unchanged.
