# @spinajs/http-socket-example

A notes server on `@spinajs/http-socket` and its client on `@spinajs/http-socket-client`. It shows:

- a typed contract shared by both sides (`src/contract.ts`)
- commands with ajv schemas, and a room push (`notes.open`, `notes.edit`, `notes.changed`)
- a snapshot as a stream reply with a credit window, resumed with `fromChunk` after a dropped connection (`notes.snapshot`, `loadSnapshot` in `src/client.ts`)
- binary payloads and results (`blob.put`, `blob.get`)
- a principal source; this demo one knows two fixed tokens

The package is an ES module, so `startNotesServer` (`src/server.ts`) calls `DI.setESMModuleSupport()` before it resolves the configuration; without it the `http.socket` defaults of `@spinajs/http-socket` are not loaded.

## Run

From the repository root, after `npm run build`:

```
cd packages/http-socket-example
npm run compile
npm start            # or: node lib/mjs/main.js --verbose
```

## Test

```
cd packages/http-socket-example
npx ts-mocha -p tsconfig.json test/example.test.ts
```
