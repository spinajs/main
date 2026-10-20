# Notes contract

`src/contract.ts` declares every command, server event and stream frame of the notes app as one TypeScript type. The server handlers and the client both use it, so a renamed command or a changed payload fails to compile on both sides.

## How it works

1. `NotesContract` is a `type` with three maps: `commands` (name to `[payload, result]`), `events` (server to client pushes) and `clientEvents` (client to server events; none here).
2. `notesContract = defineContract<NotesContract>()` from `@spinajs/http-socket-common` returns `{ kind: 'socket-contract' }`. The value carries the type only; nothing is checked at runtime.
3. The client calls `client.typed(notesContract)` and gets a `TypedSocketClient<NotesContract>`; see [Notes client](10-notes-client.md).
4. The server handlers read payload types with `In<N> = NotesContract['commands'][N][0]` and type the push payload with `NotesContract['events']['notes.changed']`; see [Socket controllers](06-socket-controllers.md).
5. Runtime validation is separate: the ajv schemas on `@Command` check payloads on the server.

## The contract

| Command | Payload | Result |
| --- | --- | --- |
| `notes.open` | `{ docId: string }` | `{ docId: string; version: number; chunks: number; openedBy: string }` |
| `notes.snapshot` | `{ docId: string; version?: number; fromChunk?: number }` | `AsyncIterable<SnapshotFrame>` (a stream reply) |
| `notes.edit` | `{ docId: string; entity: NoteEntity }` | `{ version: number }` |
| `blob.put` | `{ bytes: Bytes }` | `{ hash: string }` |
| `blob.get` | `{ hash: string }` | `Bytes` |

| Event | Payload |
| --- | --- |
| `notes.changed` | `{ docId: string; version: number; entity: NoteEntity; by: string }` |

| Type | Shape | Meaning |
| --- | --- | --- |
| `NoteEntity` | `{ id: string; text: string }` | One note |
| `SnapshotFrame` | `{ kind: 'begin'; docId; version; chunks; from }` or `{ kind: 'chunk'; index; entities }` | Items of the `notes.snapshot` stream; the stream's own end frame closes it |
| `Bytes` | `ArrayBuffer \| Uint8Array` | Binary data: a `Buffer` (a `Uint8Array`) in Node, an `ArrayBuffer` in browsers |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `NotesContract` | None: a compile-time type | `src/contract.ts` | Any `type` that fits `ContractShape` | Add an entry to `commands` or `events`, then the handler and its schema on the server |

### Contract: add a command

A new command needs three edits: the contract entry, a handler named `<prefix>.<name>`, and an ajv schema. Declare the `commands` and `events` maps as type literals or `type` aliases, never as interfaces: an interface has no implicit index signature, so it does not fit the `Record<string, ...>` maps of `ContractShape`.

```ts sample
import { defineContract } from '@spinajs/http-socket-common';
import type { NotesContract } from '@spinajs/http-socket-example/lib/mjs/contract.js';
import { connectNotes } from '@spinajs/http-socket-example/lib/mjs/client.js';
import { SocketClient } from '@spinajs/http-socket-client';

// The notes contract plus a search command served by a NotesSearchSocket controller.
type SearchableNotes = {
  commands: NotesContract['commands'] & {
    'notes.search': [{ docId: string; text: string }, { ids: string[] }];
  };
  events: NotesContract['events'];
  clientEvents: Record<string, never>;
};

const searchableNotes = defineContract<SearchableNotes>();

async function findTodos(url: string, path: string): Promise<string[]> {
  const client = new SocketClient({ url, path, clientId: 'search-cli', auth: () => ({ token: 'alice-token' }) });
  const notes = client.typed(searchableNotes);

  // still typed: the original commands are part of SearchableNotes
  await notes.command('notes.open', { docId: 'welcome' }, { whenOffline: 'wait' });
  const { ids } = await notes.command('notes.search', { docId: 'welcome', text: 'TODO' });
  notes.close();
  return ids;
}

// the example's own helper keeps returning the original contract
const plain = connectNotes('http://127.0.0.1:3000', '/socket.io', 'alice-token');
plain.close();
void findTodos;
```

## Important behaviour

- The contract is not sent over the wire. A client compiled against an older contract still connects; the server's ajv schema refuses a payload that no longer fits, with `invalid_argument`.
- A command whose result is `AsyncIterable<T>` is a stream command: call it with `stream()`, which yields `T`. `stream()` on a command that does not reply with a stream fails with `failed_precondition`.
- `clientEvents: Record<string, never>` declares that the client sends no fire-and-forget events.

## Best practices

- Keep the contract in a module both sides import and that imports nothing from the server; the example's `contract.ts` imports only `defineContract`.
- Derive handler parameter types from the contract (`NotesContract['commands']['notes.edit'][0]`) instead of restating them.
- Keep `Bytes` as `ArrayBuffer | Uint8Array` for any binary field: the runtime type differs between Node and browsers.

## Patterns and antipatterns

```ts
// Don't: an interface map has no index signature, so defineContract<NotesContract>() does not compile
interface NotesCommands {
  'notes.open': [{ docId: string }, { version: number }];
}
type NotesContract = { commands: NotesCommands; events: Record<string, never> };

// Do
type NotesCommands = {
  'notes.open': [{ docId: string }, { version: number }];
};
type NotesContract = { commands: NotesCommands; events: Record<string, never> };
```

## Related

- [`@spinajs/http-socket-common`](../http-socket-common/README.md): `defineContract`, `ContractShape` and the helper types.
- [Notes client](10-notes-client.md): the typed client built from `notesContract`.
- [Socket controllers](06-socket-controllers.md): the handlers that implement the commands.
