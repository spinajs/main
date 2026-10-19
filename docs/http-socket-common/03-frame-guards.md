# Frame guards and naming rules

Type guards that check an untrusted value against an envelope shape, and the rules for ids, names and keys. The server runs them on every frame it receives; use them in any code that reads frames off a socket.

## How it works

1. A frame arrives as `unknown` from socket.io.
2. The receiver calls the guard for that wire event, e.g. `isCommandRequest(frame)` for `cmd`.
3. The guard returns `true` and narrows the type, or `false`. Guards never throw.
4. The receiver decides what a `false` means. `@spinajs/http-socket` answers a malformed `cmd` with `invalid_argument`, drops a malformed `evt` with a debug log line, and ignores a malformed `cancel` or `credit`.

## Guards

| Guard | Narrows to | Checks |
| --- | --- | --- |
| `isCommandRequest(v)` | `CommandRequest` | `id` by `isId`, `name` by `isName`, `idempotencyKey` and `after` by `isKey` when present, `deadline` a finite number, `traceparent` a string, `credits` an integer above `0`. |
| `isEventFrame(v)` | `EventFrame` | `name` by `isName`. |
| `isCancelFrame(v)` | `CancelFrame` | `id` by `isId`. |
| `isChunk(v)` | `Chunk` | `id` by `isId`, `seq` an integer `>= 0`. |
| `isStreamEnd(v)` | `StreamEnd` | `id` by `isId`, `seq` an integer `>= 0`. |
| `isStreamFail(v)` | `StreamFail` | `id` by `isId`, `error` by `isSocketError`. |
| `isStreamCredit(v)` | `StreamCredit` | `id` by `isId`, `credits` an integer above `0`. |
| `isErrorCode(v)` | `ErrorCode` | One of `ERROR_CODES`. |
| `isSocketError(v)` | `SocketError` | `code` by `isErrorCode`, `message` a string, `retryable` a boolean, `retryAfterMs` a finite number when present, `errorId` a string when present. |

Guards check only the fields listed. `payload` and `data` are never inspected: validate them against the command's schema.

## Naming rules

| Rule | Guard | Pattern | Max length | Applies to |
| --- | --- | --- | --- | --- |
| Id | `isId` | `ID_PATTERN` = `/^[\x21-\x7E]+$/` (printable ASCII, no space) | `MAX_ID_LENGTH` = 128 | Command and cancel ids, stream frame ids, handshake `clientId`. |
| Name | `isName` | `NAME_PATTERN` = `/^[\w.:-]+$/` | `MAX_NAME_LENGTH` = 128 | Command and event names. |
| Key | `isKey` | `ID_PATTERN` | `MAX_KEY_LENGTH` = 256 | `idempotencyKey` and `after`. |

Ids and keys end up in log lines, so they cannot hold control characters, spaces or non-ASCII. Names also end up in metric labels, so they are limited to letters, digits, `_`, `.`, `:` and `-`. `MAX_KEY_LENGTH` fits a `clientId`, a separator and a nonce.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Frame validation | none, plain functions | The guards above | none | Call them from your own peer, relay or test harness; layer your own checks on the narrowed value. |

### Custom peers and relays

The guards and `WIRE_EVENTS` are enough to speak the protocol without `SocketClient`: a load-test driver, a protocol fuzzer, or a relay that forwards frames from one socket to another and must not pass on garbage. Validate with the shared guards so your peer accepts exactly what the server accepts.

```ts sample
import { WIRE_EVENTS, isCancelFrame, isCommandRequest, isEventFrame, isStreamCredit, type CommandReply } from '@spinajs/http-socket-common';

/** The part of a socket.io socket the relay needs. */
interface RelaySocket {
  on(event: string, listener: (frame: unknown, ack?: (reply: CommandReply) => void) => void): void;
  emit(event: string, frame: unknown, ack?: (reply: CommandReply) => void): void;
}

/** Forwards well-formed client frames upstream and answers malformed commands locally. */
export function relay(client: RelaySocket, upstream: RelaySocket, allow: (commandName: string) => boolean): void {
  client.on(WIRE_EVENTS.command, (frame, ack) => {
    if (!ack) {
      return;
    }
    if (!isCommandRequest(frame)) {
      ack({ id: '', ok: false, error: { code: 'invalid_argument', message: 'malformed command request', retryable: false } });
      return;
    }
    if (!allow(frame.name)) {
      ack({ id: frame.id, ok: false, error: { code: 'forbidden', message: `command ${frame.name} is not relayed`, retryable: false } });
      return;
    }
    upstream.emit(WIRE_EVENTS.command, frame, ack);
  });

  client.on(WIRE_EVENTS.event, (frame) => {
    if (isEventFrame(frame)) upstream.emit(WIRE_EVENTS.event, frame);
  });
  client.on(WIRE_EVENTS.cancel, (frame) => {
    if (isCancelFrame(frame)) upstream.emit(WIRE_EVENTS.cancel, frame);
  });
  client.on(WIRE_EVENTS.credit, (frame) => {
    if (isStreamCredit(frame)) upstream.emit(WIRE_EVENTS.credit, frame);
  });
}
```

## Important behaviour

- `isCommandRequest()` and `isEventFrame()` do not require a `payload` field.
- `isCommandRequest()` accepts `after` without `idempotencyKey`. The server refuses that combination with `invalid_argument`.
- `isCommandRequest()` accepts any finite `deadline`, including `0` and negatives; the server ignores those.
- Integer checks accept values above `Number.MAX_SAFE_INTEGER` (e.g. `1e300`). Bound `credits` yourself; the server uses its `maxCredits` limit.
- `isChunk()` accepts a chunk without `data`: an `undefined` stream item travels that way.
- `isSocketError()` does not check `details`; it is `unknown`.
- A present field set to `undefined` counts as absent: `{ id, name, credits: undefined }` passes.

## Best practices

- Reuse `isName` and `NAME_PATTERN` when you build command or event names at runtime, e.g. from a room id; a name that fails `isName` is refused by the server.
- Reuse `isId` for ids your app generates (request ids, `clientId`) before the first connect, so a bad id fails locally.

## Patterns and antipatterns

```ts
// Don't: a hand-written check drifts from what the server accepts
if (typeof frame.id === 'string' && typeof frame.name === 'string') forward(frame);

// Do: the same guard the server runs
if (isCommandRequest(frame)) forward(frame);
```

## Examples

### Build a room event name safely

```ts sample
import { MAX_NAME_LENGTH, isName } from '@spinajs/http-socket-common';

export function roomEventName(roomId: string, event: 'joined' | 'left'): string {
  const name = `room.${roomId}.${event}`;
  if (!isName(name)) {
    throw new RangeError(`room id ${JSON.stringify(roomId)} gives an invalid event name (letters, digits, _ . : - and at most ${MAX_NAME_LENGTH} characters)`);
  }
  return name;
}
```

## Related

- [Wire protocol](01-wire-protocol.md): the envelopes these guards check.
- [Error codes and `SocketException`](04-error-codes.md): `isErrorCode` and `isSocketError`.
- [`@spinajs/http-socket`](../../packages/http-socket/README.md): runs these guards on every incoming frame.
