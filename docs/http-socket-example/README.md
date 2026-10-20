# `@spinajs/http-socket-example`

A runnable notes server on [`@spinajs/http-socket`](../http-socket/README.md) and its typed client on [`@spinajs/http-socket-client`](../http-socket-client/README.md). Read it to see every extension point of the WebSocket layer wired into one small app: a shared contract, a custom configuration, a custom HTTP host, a principal source, socket controllers, a stream reply with resume, binary payloads and an injectable store.

It is **not** a library. The package is private, has no `index.ts` and its `main` (`lib/mjs/main.js`) starts a server and runs a demo. It is **not** a storage design either: `NotesStore` keeps everything in memory in one process.

## Install

The package lives in the monorepo and is never published. Build the workspace, then compile the example:

```sh
npm run build
cd packages/http-socket-example
npm run compile
```

## Run

```sh
cd packages/http-socket-example
npm start                    # node lib/mjs/main.js
node lib/mjs/main.js --verbose   # log to the console
```

`main.ts` starts the server, connects as `alice-token`, opens the `welcome` document, reads its snapshot with a credit window of 4, and stores and reads back a binary blob.

## Test

```sh
cd packages/http-socket-example
npx ts-mocha -p tsconfig.json test/example.test.ts
```

The end-to-end tests in `test/example.test.ts` cover the refused handshake, payload validation, the stream with small and default credit windows, resume after a dropped connection, restart after a concurrent edit, the room push and binary blobs.

## Features

| Feature | What it does |
| --- | --- |
| [Notes contract](01-notes-contract.md) | `NotesContract` and `notesContract`: command, event and frame types shared by server and client |
| [Server startup](02-server-startup.md) | `startNotesServer()`: boots DI and configuration, attaches socket.io, returns `INotesServer` |
| [Configuration source](03-configuration-source.md) | `NotesConfiguration`: replaces `Configuration` to set `http.socket` and logger keys in code |
| [HTTP host](04-http-host.md) | `NotesHttpHost`: replaces `SocketHttpHost` with a plain node http server |
| [Principal source](05-principal-source.md) | `DemoTokenSource`: a `SocketPrincipalSource` that signs in two fixed demo tokens |
| [Socket controllers](06-socket-controllers.md) | `NotesSocket` and `BlobSocket`: commands, ajv schemas, rooms and the `notes.changed` push |
| [Snapshot stream and resume](07-snapshot-stream.md) | `notes.snapshot` stream reply and `loadSnapshot()`, which resumes from the first missing chunk |
| [Binary blobs](08-binary-blobs.md) | `blob.put` and `blob.get`: binary payloads and binary results |
| [Notes store](09-notes-store.md) | `NotesStore`: the injectable in-memory store, and how to replace or extend it |
| [Notes client](10-notes-client.md) | `connectNotes()` and `toBytes()`: a typed `SocketClient` signed in with a demo token |

## Module map

The example has no entry point. Samples that build on its classes import the compiled modules, which `npm run compile` writes to `lib/mjs/`. Inside the package, import `./<module>.js` instead.

| Module | Exports |
| --- | --- |
| `@spinajs/http-socket-example/lib/mjs/contract.js` | `NotesContract`, `notesContract`, `NoteEntity`, `SnapshotFrame`, `Bytes` |
| `@spinajs/http-socket-example/lib/mjs/server.js` | `startNotesServer`, `INotesServer`, `INotesServerOptions`, `NotesConfiguration`, `NotesHttpHost` |
| `@spinajs/http-socket-example/lib/mjs/auth.js` | `DemoTokenSource`, `DemoUser` |
| `@spinajs/http-socket-example/lib/mjs/notes.socket.js` | `NotesSocket`, `BlobSocket` |
| `@spinajs/http-socket-example/lib/mjs/store.js` | `NotesStore`, `INoteDoc`, `chunkCount`, `ENTITIES_PER_CHUNK`, `NOTES_PER_DOC` |
| `@spinajs/http-socket-example/lib/mjs/client.js` | `connectNotes`, `NotesClient`, `loadSnapshot`, `ISnapshot`, `ILoadSnapshotOptions`, `toBytes` |

Importing `server.js` imports `auth.js` and `notes.socket.js` too, which registers `DemoTokenSource`, both controllers and `NotesHttpHost` in DI.

## Extension points at a glance

| Service | DI token and lifetime | Example implementation | Page |
| --- | --- | --- | --- |
| Configuration | `Configuration`, singleton | `NotesConfiguration` | [Configuration source](03-configuration-source.md) |
| HTTP server for socket.io | `SocketHttpHost`, singleton | `NotesHttpHost` | [HTTP host](04-http-host.md) |
| Handshake authentication | `SocketPrincipalSource`, list, singleton each | `DemoTokenSource` | [Principal source](05-principal-source.md) |
| Socket controllers | `BaseSocketController`, list, singleton each | `NotesSocket`, `BlobSocket` | [Socket controllers](06-socket-controllers.md) |
| App state | `NotesStore`, singleton | `NotesStore` | [Notes store](09-notes-store.md) |
| Wire types | `defineContract<C>()`, no DI | `NotesContract` | [Notes contract](01-notes-contract.md) |

## Quick start

```ts sample
import { connectNotes, loadSnapshot } from '@spinajs/http-socket-example/lib/mjs/client.js';
import { startNotesServer } from '@spinajs/http-socket-example/lib/mjs/server.js';

async function demo(): Promise<void> {
  const server = await startNotesServer();
  const notes = connectNotes(server.url, server.path, 'alice-token');

  try {
    const opened = await notes.command('notes.open', { docId: 'welcome' }, { whenOffline: 'wait' });
    const snapshot = await loadSnapshot(notes, 'welcome', { credits: 4 });
    console.log(`${opened.openedBy} read ${snapshot.entities.length} notes at v${snapshot.version}`);
  } finally {
    notes.close();
    await server.close();
  }
}

void demo();
```

## Related packages

- [`@spinajs/http-socket`](../http-socket/README.md): the server side every page here builds on.
- [`@spinajs/http-socket-client`](../http-socket-client/README.md): `SocketClient`, typed clients, streams, reconnect.
- [`@spinajs/http-socket-common`](../http-socket-common/README.md): `defineContract`, `SocketException`, error codes.
- [`@spinajs/di`](../di/README.md): registration, lifetimes and lists used by every extension point.
- [`@spinajs/configuration`](../configuration/README.md): `Configuration`, `FrameworkConfiguration` and schema validation.
- [`@spinajs/authz`](../authz/README.md): the `Principal` a principal source returns.
