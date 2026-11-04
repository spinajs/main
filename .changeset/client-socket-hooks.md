---
"@spinajs/client": minor
---

`generateClientFiles({ hooks, socketHooks: true })` now writes socket hooks over `TypedSocketClient` from `@spinajs/http-socket-client` (a type-only import; the package is a new optional peer):

- `client.socket.ts` (first statement `'use client'`), for either hooks library. Per contract it exports `<Contract>Socket = TypedSocketClient<ContractOf<typeof <contract>Contract>>`. Per server event it exports `use<Contract><Event>Event(socket, listener)`, which subscribes once per socket, calls the latest listener without subscribing again, and unsubscribes on unmount. Per stream command it exports `use<Contract><Command>Stream(socket, payload | null)`, which returns `SocketStreamState<Item>` (`items`, `status`, `error`). The stream hook accumulates the items, reopens the stream only when the socket or the JSON of the payload changes, opens nothing for `null`, and calls the iterator's `return()` on unmount or on a payload change.
- `client.socket-swr.ts` (first statement `'use client'`), only with `hooks: ['swr']`. Per server event it exports `use<Contract><Event>Latest(socket)`, which holds the latest payload through `swr/subscription`, keyed `[keyPrefix, '#socket', <contract>, <event>, socket]`.

Hook names join the contract name with the PascalCase words of the event or command name, so `docs.committed` on the `chat` contract becomes `useChatDocsCommittedEvent`. Two hooks that would share a name, or a payload type that would take a name the socket files declare, are refused. `socketHooks` with `includeSocket: false` is refused. The `socket-hooks` generator target is now available. Without `socketHooks`, the output is unchanged.
