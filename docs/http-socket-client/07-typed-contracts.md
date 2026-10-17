# Typed contracts

A contract is one type shared by the server and the client. `client.typed(contract)` returns the same client typed by it, so command names, payloads, results, stream items and event payloads are checked at compile time. It costs nothing at runtime.

## How it works

1. Declare the contract as a `type` with `commands`, `events` and optionally `clientEvents`.
2. Create the token with `defineContract<C>()`. At runtime it is `{ kind: 'socket-contract' }`; the type rides along.
3. `client.typed(token)` returns `this` as a `TypedSocketClient<C>`.
4. Each method of `TypedSocketClient<C>` takes only names of `C` and the payload type that name declares:

| Method | Name from | Payload type | Result type |
| --- | --- | --- | --- |
| `command(name, payload, options?)` | `CommandName<C>` | `CommandPayload<C, N>` | `Promise<CommandResult<C, N>>` |
| `durable(name, payload, options?)` | `CommandName<C>` | `CommandPayload<C, N>` | `Promise<CommandResult<C, N>>` |
| `stream(name, payload, options?)` | `CommandName<C>` | `CommandPayload<C, N>` | `AsyncIterableIterator<StreamItem<C, N>>` |
| `emit(name, payload)` | `ClientEventName<C>` | `ClientEventPayload<C, N>` | `boolean` |
| `on`, `once`, `off` | `EventName<C>` or a lifecycle event | `EventPayload<C, N>` | `Unsubscribe` (`on`, `once`) |

`StreamItem<C, N>` is `Item` when the command's result is `AsyncIterable<Item>`, and the result type otherwise.

### Contract shape

| Key | Type | Meaning |
| --- | --- | --- |
| `commands` | `Record<string, [payload, result]>` | Command name to its payload and result; a stream command declares `AsyncIterable<Item>` as its result. |
| `events` | `Record<string, payload>` | Server-to-client events. |
| `clientEvents` | `Record<string, payload>`, optional | Client-to-server events. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TypedSocketClient<C>` | none; `client.typed(contract)`, same instance as the client | `SocketClient` seen through `C` | any number of contracts on one client | Call `typed()` once per contract; wrap the typed client in a domain class to hide names entirely. |

### TypedSocketClient: wrap it in a domain API

Wrap the typed client when the rest of the app should call `docs.open(id)` and never see command names. The wrapper only forwards, so it stays as flexible as the client: options, signals and durability pass through.

```ts sample
import { SocketClient, defineContract, type CommandOptions, type TypedSocketClient } from '@spinajs/http-socket-client';

export interface DocSummary {
  id: string;
  title: string;
}

export interface SnapshotFrame {
  index: number;
  rows: string[];
}

export type DocsContract = {
  commands: {
    'docs.open': [{ id: string }, DocSummary];
    'docs.rename': [{ id: string; title: string }, DocSummary];
    'docs.snapshot': [{ docId: string; fromChunk?: number }, AsyncIterable<SnapshotFrame>];
  };
  events: { 'docs.committed': { docId: string; seq: number } };
  clientEvents: { 'docs.cursor': { x: number; y: number } };
};

export const docsContract = defineContract<DocsContract>();

/** The documents API the app calls; command names stay in this file. */
export class DocsApi {
  private readonly socket: TypedSocketClient<DocsContract>;

  constructor(client: SocketClient) {
    this.socket = client.typed(docsContract);
  }

  public open(id: string, options?: CommandOptions): Promise<DocSummary> {
    return this.socket.command('docs.open', { id }, options);
  }

  public rename(id: string, title: string, opId: string): Promise<DocSummary> {
    return this.socket.durable('docs.rename', { id, title }, { key: opId });
  }

  public snapshot(docId: string, fromChunk = 0): AsyncIterableIterator<SnapshotFrame> {
    return this.socket.stream('docs.snapshot', { docId, fromChunk }, { whenOffline: 'wait' });
  }

  public onCommitted(listener: (event: { docId: string; seq: number }) => void): () => void {
    return this.socket.on('docs.committed', listener);
  }

  public moveCursor(x: number, y: number): boolean {
    return this.socket.emit('docs.cursor', { x, y });
  }
}

export const docs = new DocsApi(new SocketClient({ url: 'https://app.example.com', clientId: 'web-4f1c2a' }));
```

## Important behaviour

- Declare contracts with `type`, not `interface`: only a type alias gets the implicit index signature that `Record<string, ...>` requires.
- `typed()` returns the same object. State, listeners and overrides of a `SocketClient` subclass are shared with the typed view.
- Types are not checked at runtime. A server that answers another shape is not detected.
- `command()` on a stream command type-checks (its result type is `AsyncIterable<Item>`) but rejects at runtime with `failed_precondition`. Use `stream()` for those names.
- `TypedSocketClient.close()` is declared as returning `void`, while `SocketClient.close()` returns a promise. Keep the `SocketClient` reference to `await` the close.
- The server imports `defineContract` and the contract types from `@spinajs/http-socket-common` (or `@spinajs/http-socket`, which re-exports it). This package re-exports them too.

## Best practices

- Put the contract in one module that both the server and the client import, as `packages/http-socket-example/src/contract.ts` does.
- Type binary fields as `Uint8Array | ArrayBuffer` on the result side: browsers receive an `ArrayBuffer`, Node a `Buffer`.
- Split a large API into several contracts, one per feature, and call `typed()` once per contract.

## Patterns and antipatterns

```ts
// Don't: an interface has no implicit index signature; defineContract<DocsContract>() fails to compile
export interface DocsContract {
  commands: { 'docs.open': [{ id: string }, DocSummary] };
  events: {};
}

// Do
export type DocsContract = {
  commands: { 'docs.open': [{ id: string }, DocSummary] };
  events: {};
};
```

## Examples

### Share one contract between server and client

```ts sample
import { SocketClient, defineContract } from '@spinajs/http-socket-client';

export type NotesContract = {
  commands: {
    'notes.create': [{ text: string }, { id: string; createdAt: string }];
    'notes.list': [{ limit: number }, AsyncIterable<{ id: string; text: string }>];
  };
  events: { 'notes.created': { id: string } };
};

export const notesContract = defineContract<NotesContract>();

export async function printNotes(client: SocketClient): Promise<void> {
  const notes = client.typed(notesContract);
  const created = await notes.command('notes.create', { text: 'Buy milk' });
  console.log(`created ${created.id} at ${created.createdAt}`);

  for await (const note of notes.stream('notes.list', { limit: 50 })) {
    console.log(note.id, note.text);
  }
}
```

## Related

- [Commands](02-commands.md), [Durable commands](04-durable-commands.md), [Streams](06-streams.md), [Events](03-events.md): the untyped methods behind the typed view.
- [`@spinajs/http-socket-common`](../http-socket-common/README.md): `defineContract` and the contract helper types.
- [`@spinajs/http-socket`](../http-socket/README.md): how the server binds controllers to the same contract.
