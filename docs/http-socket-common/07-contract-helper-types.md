# Contract helper types

Generic types that read names and payloads out of a [contract](06-typed-contracts.md). `@spinajs/http-socket-client` builds `TypedSocketClient` from them; use them to type server handlers, test fakes and wrappers of your own.

## How it works

1. Each helper takes the contract type `C` (and a name `N` where it applies).
2. It resolves to a string-literal union of names or to the payload or result type of one name.
3. A name outside the contract fails to compile, so every wrapper built on these helpers inherits the contract's checks.

## Helper types

| Type | Resolves to |
| --- | --- |
| `CommandName<C>` | Union of the command names in `C['commands']`. |
| `CommandPayload<C, N>` | `C['commands'][N][0]`, the payload of command `N`. |
| `CommandResult<C, N>` | `C['commands'][N][1]`, the result of command `N`. |
| `EventName<C>` | Union of the server event names in `C['events']`. |
| `EventPayload<C, N>` | `C['events'][N]`. |
| `ClientEventName<C>` | Union of the client event names in `C['clientEvents']`; `never` when the contract has none. |
| `ClientEventPayload<C, N>` | `C['clientEvents'][N]`. |
| `ContractOf<T>` | `C` of a `SocketContract<C>`, `never` for anything else. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Typed contract API | none, types | `TypedSocketClient<C>` in `@spinajs/http-socket-client` | Your own wrappers | Build a generic over `C extends ContractShape` with the helpers above. |

### Typed wrapper: custom implementation

A fake client for unit tests of UI code: it answers commands from an in-memory handler map that must cover every command of the contract, and lets the test push server events. It needs no server and no socket.

```ts sample
import {
  SocketException,
  defineContract,
  type CommandName,
  type CommandPayload,
  type CommandResult,
  type ContractOf,
  type ContractShape,
  type EventName,
  type EventPayload,
  type SocketContract,
} from '@spinajs/http-socket-common';

export type CommandHandlers<C extends ContractShape> = {
  [N in CommandName<C>]: (payload: CommandPayload<C, N>) => CommandResult<C, N> | Promise<CommandResult<C, N>>;
};

export class FakeSocketClient<C extends ContractShape> {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(private readonly handlers: CommandHandlers<C>) {}

  public async command<N extends CommandName<C>>(name: N, payload: CommandPayload<C, N>): Promise<CommandResult<C, N>> {
    const handler = this.handlers[name];
    if (!handler) {
      throw new SocketException('unimplemented', `unknown command ${name}`);
    }
    return handler(payload);
  }

  public on<N extends EventName<C>>(name: N, listener: (payload: EventPayload<C, N>) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener as (payload: unknown) => void);
    this.listeners.set(name, set);
    return () => set.delete(listener as (payload: unknown) => void);
  }

  /** Test helper: deliver a server event. */
  public push<N extends EventName<C>>(name: N, payload: EventPayload<C, N>): void {
    this.listeners.get(name)?.forEach((listener) => listener(payload));
  }
}

export function fakeFor<T extends SocketContract<ContractShape>>(_contract: T, handlers: CommandHandlers<ContractOf<T>>): FakeSocketClient<ContractOf<T>> {
  return new FakeSocketClient(handlers);
}

// usage in a test
type TodoContract = {
  commands: {
    'todo.add': [{ title: string }, { id: string }];
    'todo.list': [Record<string, never>, { id: string; title: string }[]];
  };
  events: { 'todo.added': { id: string; title: string } };
};
const todoContract = defineContract<TodoContract>();

const todos: { id: string; title: string }[] = [];
const fake = fakeFor(todoContract, {
  'todo.add': ({ title }) => {
    const todo = { id: String(todos.length + 1), title };
    todos.push(todo);
    fake.push('todo.added', todo);
    return { id: todo.id };
  },
  'todo.list': () => todos,
});

export async function addAndList(): Promise<void> {
  fake.on('todo.added', (todo) => console.log('added', todo.title));
  await fake.command('todo.add', { title: 'write docs' });
  console.log(await fake.command('todo.list', {}));
}
```

Leaving out a command from the handler map, misspelling a name or returning the wrong result type fails to compile.

### Server handlers typed by the contract

On the server, the helpers tie a controller method to the contract the client uses:

```ts
@Command('edit', { schema: EditSchema })
public async edit(@Payload() req: CommandPayload<NotesContract, 'notes.edit'>): Promise<CommandResult<NotesContract, 'notes.edit'>> {
  return { version: await this.Store.edit(req.docId, req.entity) };
}
```

`@Command('edit')` in `@SocketController('notes')` must answer the name `notes.edit`; the helper types do not check that link.

## Important behaviour

- The helpers are types only. They add no runtime code and no validation.
- `CommandName<C>` keeps string keys only (`Extract<keyof ..., string>`).
- `ClientEventName<C>` is `never` when `C` has no `clientEvents`, so wrappers built on it cannot emit.
- `CommandResult<C, N>` of a stream command is the `AsyncIterable<Item>` itself; the client's `StreamItem<C, N>` unwraps `Item`.

## Best practices

- Write wrappers as generics over `C extends ContractShape` and take the marker (`SocketContract<C>`) as an argument, as `client.typed()` does; `ContractOf<T>` recovers `C` from it.
- Type a server event push with `EventPayload<C, N>` so the payload matches what `client.on(N, ...)` expects.

## Patterns and antipatterns

```ts
// Don't: indexed access by hand repeats the contract layout and breaks if it changes
type In = NotesContract['commands']['notes.open'][0];

// Do
type In = CommandPayload<NotesContract, 'notes.open'>;
```

## Related

- [Typed contracts](06-typed-contracts.md): how to declare `C`.
- [`@spinajs/http-socket-client`](../../packages/http-socket-client/README.md): `TypedSocketClient<C>` and `StreamItem<C, N>`, built on these helpers.
- [`@spinajs/http-socket`](../../packages/http-socket/README.md): the controllers whose handlers these types annotate.
