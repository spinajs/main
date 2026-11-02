# Typed contracts

A contract is one TypeScript type that lists every command (payload and result), every server event and every client event of a socket API. The server and the client import the same contract module, so a renamed command or a changed payload fails to compile on both sides.

## How it works

1. You declare a contract type that satisfies `ContractShape`.
2. `defineContract<C>()` returns a `SocketContract<C>` marker: `{ kind: 'socket-contract' }`. The type `C` rides on it; nothing else exists at runtime.
3. The client passes the marker to `client.typed(contract)` of `@spinajs/http-socket-client` and gets a `TypedSocketClient<C>`: `command`, `durable`, `stream`, `emit`, `on`, `once` and `off` check names and payloads against `C`.
4. The server types its handlers with the [contract helper types](07-contract-helper-types.md) (`CommandPayload`, `CommandResult`, `EventPayload`).
5. The marker itself is not checked at runtime. The server validates each payload with the command's schema, and can also enforce the contract itself; see [Server enforcement](#server-enforcement).

## `ContractShape`

| Key | Type | Meaning |
| --- | --- | --- |
| `commands` | `Record<string, readonly [payload, result]>` | Command name to a `[payload, result]` tuple. A stream command declares its result as `AsyncIterable<Item>`. |
| `events` | `Record<string, unknown>` | Server-to-client event name to payload. |
| `clientEvents` | `Record<string, unknown>`, optional | Client-to-server event name to payload. |

Names follow the [name rule](03-frame-guards.md#naming-rules): letters, digits, `_`, `.`, `:` and `-`, at most 128 characters. The contract type does not enforce it.

## Exports

| Export | Kind | Meaning |
| --- | --- | --- |
| `ContractShape` | interface | The constraint every contract satisfies. |
| `SocketContract<C>` | interface | The runtime marker; `kind` is `'socket-contract'`, `__contract` is a type carrier, never set. |
| `defineContract<C>(id?)` | function | Returns the marker for `C`. The optional `id` names the contract in the manifest. |
| `ContractOf<T>` | type | Extracts `C` from `SocketContract<C>`, e.g. `ContractOf<typeof notesContract>`. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| App contract | none, a type | none | One contract per socket API | Declare a `type` satisfying `ContractShape`, export it with `defineContract<C>()`. |

### Contract: custom implementation

A notes app with a plain command, a stream command and a server event, shared by server and client:

```ts sample
import { defineContract, type ContractOf } from '@spinajs/http-socket-common';

export interface NoteEntity {
  id: string;
  text: string;
}

export type SnapshotFrame = { kind: 'begin'; version: number } | { kind: 'chunk'; entities: NoteEntity[] };

export type NotesContract = {
  commands: {
    'notes.open': [{ docId: string }, { docId: string; version: number }];
    'notes.edit': [{ docId: string; entity: NoteEntity }, { version: number }];
    // a stream command: the client reads it with stream(), which yields SnapshotFrame items
    'notes.snapshot': [{ docId: string }, AsyncIterable<SnapshotFrame>];
  };
  events: {
    'notes.changed': { docId: string; version: number; entity: NoteEntity; by: string };
  };
  clientEvents: {
    'notes.cursor': { docId: string; entityId: string };
  };
};

export const notesContract = defineContract<NotesContract>();

// the contract type back from the marker, for code that only receives the marker
export type Notes = ContractOf<typeof notesContract>;
```

The client side, with `@spinajs/http-socket-client`:

```ts
const notes = new SocketClient({ url, clientId }).typed(notesContract);

const opened = await notes.command('notes.open', { docId: 'd1' }); // { docId, version }
for await (const frame of notes.stream('notes.snapshot', { docId: 'd1' })) render(frame);
notes.on('notes.changed', (change) => apply(change));
```

## Server enforcement

A contract is only a type until a server binds to it. `@SocketController(prefix, { contract })` from `@spinajs/http-socket` binds a controller to a contract, and the server then checks the controller against it and validates incoming payloads with the contract's schemas:

```ts
import { SocketController } from '@spinajs/http-socket';
import { notesContract } from './contract.js';

@SocketController('notes', { contract: notesContract })
export class NotesController {
  /* @Command / @OnEvent handlers for every name the contract declares */
}
```

- The check needs the application manifest (`spinajs build` reads the contract from `defineContract<C>()`, derives the payload schemas from `C`, and writes them to `manifest.socketContracts`) and a `system.manifest.mode` other than `off`. With `off` the `contract` option does nothing.
- In `require` mode a handler that is missing or incompatible, or a manifest that does not hold the contract, fails the boot; `prefer` logs a warning and does not enforce what it could not verify. The mode table is in [Server-enforced contracts](../http-socket/02-controllers.md#server-enforced-contracts).
- An incoming command or client-event payload is validated against the contract schema before the handler runs and answers `invalid_argument` on failure. A schema derived with `--no-schemas` is absent, which fails a `require` boot.
- `spinajs doctor` checks the same binding ahead of time: `SOCK001` (a name the contract declares has no handler, or the contract is not in the manifest), `SOCK002` (a handler payload accepts less than a client may send), `SOCK003` (a handler result returns more than promised), `SOCK004` (the contract cannot be resolved), `SOCK005` (two contracts share an id) and `SOCK006` (a `$data` pointer names no required property). See [spinajs doctor](../compiler/doctor.md#rules).
- A contract with no explicit `id` takes `<package>:<VARIABLE>` from the compiler. An explicit id must be unique across the app and its packages.

The client-side `typed()` check stays a compile-time check; enforcement protects the server from clients that were not built against the contract.

## Important behaviour

- The maps under `commands`, `events` and `clientEvents` must be type literals or `type` aliases. An `interface` used as one of those maps has no implicit index signature and fails the `ContractShape` constraint. The outer contract may be either.
- A contract that leaves out `clientEvents` gives `ClientEventName<C>` = `never`: the typed client's `emit()` accepts no name. `clientEvents: Record<string, never>` accepts any name but makes every payload `never`, so `emit()` cannot be called either.
- `defineContract()` costs nothing at runtime and carries no data, so it is safe in browser bundles.
- The contract marker is not a schema. A client built from another contract version compiles and still sends frames; the server's command schemas refuse bad payloads, and a controller bound with `{ contract }` is [enforced](#server-enforcement) against the manifest's copy of the contract.

## Best practices

- Keep the contract in its own module with no server imports, so the client bundle does not pull in server code.
- Prefix names with the controller prefix the server uses: `@SocketController('notes')` with `@Command('open')` answers `notes.open`.
- Declare stream results as `AsyncIterable<Item>`; the typed client's `stream()` yields `Item`.

## Patterns and antipatterns

```ts
// Don't: an interface as the commands map fails ContractShape
interface Commands { 'notes.open': [{ docId: string }, { version: number }] }
type NotesContract = { commands: Commands; events: {} };

// Do: a type literal (or a type alias)
type NotesContract = { commands: { 'notes.open': [{ docId: string }, { version: number }] }; events: {} };
```

## Related

- [Server-enforced contracts](../http-socket/02-controllers.md#server-enforced-contracts): modes, failure behaviour and the schema rules.
- [Contract helper types](07-contract-helper-types.md): derive names and payloads from a contract.
- [Custom socket exceptions](05-custom-socket-exceptions.md): error recognisers that belong next to the contract.
- [`@spinajs/http-socket-client`](../../packages/http-socket-client/README.md): `client.typed()` and `TypedSocketClient`.
- [`packages/http-socket-example`](../../packages/http-socket-example/src/contract.ts): a full contract used by a server and a client.
