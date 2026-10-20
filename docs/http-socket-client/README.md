# `@spinajs/http-socket-client`

Client for a `@spinajs/http-socket` server, for browsers and Node. It owns the connection state and reconnects with backoff, and it sends commands with timeouts and cancellation. It also receives server events, reads stream replies with flow control, keeps durable commands in an outbox, and types all of it through a contract shared with the server.

It does **not** use the spinajs DI container: everything is a constructor option or an object you pass in. It does **not** resume streams or resend plain commands; only `durable()` commands are sent again.

## Install

```sh
npm install @spinajs/http-socket-client
```

Its runtime dependencies are `socket.io-client` and `@spinajs/http-socket-common`, whose exports it re-exports (`SocketException`, `defineContract`, `ERROR_CODES` and the wire types).

| Entry | What it adds | Runs in |
| --- | --- | --- |
| `@spinajs/http-socket-client` | `SocketClient`, `MemoryOutboxStore`, `ReconnectPolicy`, types and defaults | browsers and Node |
| `@spinajs/http-socket-client/browser` | everything above, plus `IndexedDbOutboxStore` | browsers |
| `@spinajs/http-socket-client/node` | everything above, plus `FileOutboxStore` | Node |

The main entry imports no Node built-in and uses no Node global; Node-only code sits behind `/node`.

## Features

| Feature | What it does |
| --- | --- |
| [Connection and reconnect](01-connection-and-reconnect.md) | Connection states, the handshake, `auth()`, backoff, stop conditions, `socket.io-client` options. |
| [Commands](02-commands.md) | `command()`: one request, one reply, with a timeout, cancellation and offline handling. |
| [Events](03-events.md) | Server events, client events and the client's lifecycle events. |
| [Durable commands](04-durable-commands.md) | `durable()`: persisted, ordered, exactly-once commands that survive drops and reloads. |
| [Outbox stores](05-outbox-stores.md) | The `OutboxStore` extension point: memory, IndexedDB, file, or your own. |
| [Streams](06-streams.md) | `stream()`: a stream reply as an async iterator with credit-based flow control. |
| [Typed contracts](07-typed-contracts.md) | `typed()`: command, event and payload types from a contract shared with the server. |
| [Errors and retries](08-errors-and-retries.md) | Every error the client produces, what `retryable` means, and how to retry. |

## Extension points

The package has no DI registrations. You extend it through these seams:

| Extension point | Kind | Page |
| --- | --- | --- |
| `OutboxStore` | interface, three shipped implementations | [Outbox stores](05-outbox-stores.md) |
| `AuthProvider` (`auth` option) | callback, asked on every (re)connect | [Connection and reconnect](01-connection-and-reconnect.md#authprovider-custom-implementation) |
| `IoOptions` (`io` option) | pass-through to `socket.io-client` | [Connection and reconnect](01-connection-and-reconnect.md#iooptions-custom-transport-settings) |
| `ReconnectOptions` / `ReconnectPolicy` | options, and a reusable backoff class | [Errors and retries](08-errors-and-retries.md#reconnectpolicy-reuse-for-your-own-retries) |
| `onListenerError` | hook for listener and background store errors | [Events](03-events.md#onlistenererror-custom-implementation) |
| `SocketClient` subclass | override of the public methods | [Commands](02-commands.md#socketclient-subclass-that-adds-call-defaults) |
| `TypedSocketClient<C>` | compile-time view through a contract | [Typed contracts](07-typed-contracts.md) |

## Quick start

```ts sample
import { SocketClient, SocketException } from '@spinajs/http-socket-client';

interface OpenedDocument {
  title: string;
  revision: number;
}

export async function openDocument(token: string, documentId: string): Promise<OpenedDocument> {
  const client = new SocketClient({
    url: 'https://app.example.com',
    clientId: 'web-4f1c2a',
    auth: () => ({ token }),
  });

  try {
    return await client.command<OpenedDocument>('docs.open', { id: documentId }, { whenOffline: 'wait', timeoutMs: 5_000 });
  } catch (error) {
    if (error instanceof SocketException && error.code === 'not_found') {
      throw new Error(`document ${documentId} does not exist`);
    }
    throw error;
  } finally {
    await client.close();
  }
}
```

A runnable server and client live in [`packages/http-socket-example`](../../packages/http-socket-example/README.md).

## Related packages

- [`@spinajs/http-socket`](../http-socket/README.md): the server this client talks to; it defines commands, streams, idempotency and ordering.
- [`@spinajs/http-socket-common`](../http-socket-common/README.md): the wire protocol, `SocketException`, error codes and `defineContract`, shared by both sides.
- [`packages/http-socket-example`](../../packages/http-socket-example/README.md): a complete server and client, including a resumable snapshot stream.
