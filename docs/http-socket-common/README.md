# `@spinajs/http-socket-common`

The wire protocol shared by the spinajs WebSocket server (`@spinajs/http-socket`) and client (`@spinajs/http-socket-client`): protocol version, wire event names, envelope types, frame guards, the 13 error codes with `SocketException`, and the typed-contract helpers.

It has no dependencies and runs in browsers and Node. It does **not** open sockets, register anything in DI or read configuration. Both the server and the client re-export everything from it, so an app usually imports from one of them; import from `@spinajs/http-socket-common` directly in a contract module shared by both sides.

## Install

```sh
npm install @spinajs/http-socket-common
```

## Features

| Feature | What it does |
| --- | --- |
| [Wire protocol](01-wire-protocol.md) | `PROTOCOL_VERSION`, `WIRE_EVENTS`, `SYSTEM_EVENTS` and the envelopes of commands, events, streams and cancels. |
| [Handshake](02-handshake.md) | The `Handshake` a client sends on connect, how the server refuses it, and how to add app fields to it. |
| [Frame guards and naming rules](03-frame-guards.md) | `isCommandRequest` and the other guards, and the id, name and key rules (`isId`, `isName`, `isKey`). |
| [Error codes and `SocketException`](04-error-codes.md) | `ErrorCode`, `DEFAULT_RETRYABLE`, the wire `SocketError` and the throwable `SocketException`. |
| [Custom socket exceptions](05-custom-socket-exceptions.md) | Subclass `SocketException` for domain errors and shape their wire form by overriding `toWire()`. |
| [Typed contracts](06-typed-contracts.md) | `defineContract<C>()` and `ContractShape`: one module that types the commands and events of both sides. |
| [Contract helper types](07-contract-helper-types.md) | `CommandName`, `CommandPayload`, `CommandResult` and friends, for typed handlers, fakes and wrappers of your own. |

## Extension points

The package has no DI services. It is extended by code and types:

| Extension point | Mechanism | Page |
| --- | --- | --- |
| App fields in the handshake | `Handshake` index signature, filled by the client's `auth` callback | [Handshake](02-handshake.md#app-fields-custom-handshake-data) |
| Custom protocol peers | Exported guards and constants (`isCommandRequest`, `WIRE_EVENTS`, ...) | [Frame guards](03-frame-guards.md#custom-peers-and-relays) |
| Domain exceptions | `class X extends SocketException`, override `toWire()` | [Custom socket exceptions](05-custom-socket-exceptions.md) |
| App contracts | A `type` that satisfies `ContractShape`, passed to `defineContract<C>()` | [Typed contracts](06-typed-contracts.md) |
| Typed wrappers | `CommandName<C>`, `CommandPayload<C, N>`, `ContractOf<T>`, ... | [Contract helper types](07-contract-helper-types.md) |

## Quick start

```ts sample
import { SocketException, defineContract, type CommandPayload, type CommandResult } from '@spinajs/http-socket-common';

// contract.ts, imported by the server and the client
export type ChatContract = {
  commands: {
    'chat.send': [{ room: string; text: string }, { messageId: string }];
  };
  events: {
    'chat.message': { room: string; text: string; from: string };
  };
  clientEvents: {
    'chat.typing': { room: string };
  };
};

export const chatContract = defineContract<ChatContract>();

// a server handler typed by the contract
export async function send(payload: CommandPayload<ChatContract, 'chat.send'>): Promise<CommandResult<ChatContract, 'chat.send'>> {
  if (payload.text.length === 0) {
    throw new SocketException('invalid_argument', 'empty message', { details: { field: 'text' } });
  }
  return { messageId: `${payload.room}:${Date.now()}` };
}
```

## Related packages

- [`@spinajs/http-socket`](../../packages/http-socket/README.md): the server; validates frames with these guards, maps errors to `SocketError` and checks `PROTOCOL_VERSION` on handshake.
- [`@spinajs/http-socket-client`](../../packages/http-socket-client/README.md): the client; sends these envelopes, rejects command promises with `SocketException` and types itself with `client.typed(contract)`.
- [`packages/http-socket-example`](../../packages/http-socket-example): a runnable server and client sharing one contract.
