# Limits

Every connection is bounded: a payload size limit, a token-bucket rate limit shared by commands and events, a cap on commands running at once, and a cap on events waiting or running. Refusals answer `resource_exhausted`, with `retryAfterMs` when waiting helps.

## How it works

Commands:

1. On arrival, `SocketDispatcher` takes one token from the connection's `TokenBucket`; every `cmd` frame pays, also frames without an ack, malformed frames and duplicate ids.
2. `SizeStage` (100) measures the payload with `payloadSize()`: the UTF-8 length of its JSON plus the byte length of every binary part. Over `maxPayloadBytes` answers `resource_exhausted`, **not** retryable, with `details { size, limit }`. A payload that cannot be serialized (BigInt, cycle) answers `invalid_argument`.
3. `RateStage` (200) answers the token refusal from step 1: `resource_exhausted` with `retryAfterMs` until the next token.
4. `InFlightStage` (300) holds one of `maxInFlightPerConnection` slots until the handler settles, even after an abort answered the client. No free slot answers `resource_exhausted` with `retryAfterMs: 100`.

Events:

1. The size check and a rate token, before anything waits.
2. One of `maxInFlightEventsPerConnection` slots, from arrival until the handler settles; it also covers the wait for connect hooks.
3. A refused event is dropped and logged; size, rate and slot refusals at debug level.

Transport:

- socket.io's `maxHttpBufferSize` is `2 × maxPayloadBytes`. A frame between the two limits is refused by the size check (a command is answered `resource_exhausted`); a larger one makes socket.io close the connection.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `http.socket.maxPayloadBytes` | integer | `1048576` | above 0 | Command and event payload limit; binary parts count by byte length |
| `http.socket.rate.perSecond` | number | `50` | above 0 | Token refill rate per connection |
| `http.socket.rate.burst` | number | `100` | above 0 | Bucket size: frames a connection may send at once |
| `http.socket.maxInFlightPerConnection` | integer | `32` | above 0 | Commands running at once per connection |
| `http.socket.maxInFlightEventsPerConnection` | integer | `128` | integer, at least `rate.burst` | Events waiting or running per connection |
| `http.socket.streams.*` | | | | Stream limits; see [Stream replies](06-stream-replies.md#configuration) |

```ts
http: {
  socket: {
    maxPayloadBytes: 256 * 1024,
    rate: { perSecond: 20, burst: 40 },
    maxInFlightPerConnection: 8,
    maxInFlightEventsPerConnection: 40,
  },
},
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `SizeStage`, `RateStage`, `InFlightStage` | `SocketCommandStage`, orders 100, 200, 300 | as named | Your stages | Subclass and swap with `DI.unregister()`; see [Command pipeline](04-command-pipeline.md#replace-a-built-in-stage) for a per-command size limit |
| `TokenBucket` | Not in DI: `new TokenBucket(perSecond, burst, now?)` | one per connection, built by `SocketDispatcher.attach()` | Your buckets in your own stages | `take()` spends a token, `retryAfterMs()` tells when the next one comes |
| `payloadSize(value)` | Function | the size stage's measure | none | Use it in your own limit checks |

### `TokenBucket`: a stricter rate for one expensive command

The connection bucket is shared by all frames. A stage can add a second bucket for one command, keyed by the connection object.

```ts sample
import { Injectable } from '@spinajs/di';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage, SocketConnection, SocketException, TokenBucket } from '@spinajs/http-socket';

/** 'reports.render' may run once per 10 s per connection, with no burst. */
@Injectable(SocketCommandStage)
export class RenderRateStage extends SocketCommandStage {
  protected buckets = new WeakMap<SocketConnection, TokenBucket>();

  public get Order(): number {
    return STAGE_ORDER.Lookup + 20;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    if (ctx.handler?.fullName !== 'reports.render') {
      return next();
    }

    let bucket = this.buckets.get(ctx.connection);
    if (!bucket) {
      bucket = new TokenBucket(0.1, 1);
      this.buckets.set(ctx.connection, bucket);
    }

    if (!bucket.take()) {
      throw new SocketException('resource_exhausted', 'reports.render is limited to one call per 10 s', { retryAfterMs: bucket.retryAfterMs() });
    }

    return next();
  }
}
```

## Important behaviour

- The size refusal is the one `resource_exhausted` that is not retryable: resending the same payload cannot succeed.
- The rate token is taken before any other check, so no refusal or log line comes for free.
- A refused frame without an ack is dropped silently.
- An open stream holds no in-flight slot; it holds a stream slot (`streams.maxPerConnection`).
- The in-flight slot is kept until the handler settles, so cancel-and-resend cannot run unbounded handlers.
- `maxInFlightEventsPerConnection` below `rate.burst` fails the configuration schema: it would drop events the rate limit lets through.
- Limits are per connection, not per principal: a user with ten tabs gets ten budgets.

## Best practices

- Size `maxPayloadBytes` to your largest legitimate command; binary uploads larger than that belong in http.
- Keep `rate.burst` above what a client sends on reconnect, when its durable queue resends up to `durable.window` commands at once.
- Honour `retryAfterMs` in custom clients; the official client does.

## Patterns and antipatterns

```ts
// Don't: raise maxPayloadBytes for one upload command; every command and event gets the bigger limit
http: { socket: { maxPayloadBytes: 50 * 1024 * 1024 } }

// Do: keep the socket limit small, and upload large files over http
http: { socket: { maxPayloadBytes: 1024 * 1024 } }
```

## Examples

### Measure a payload before sending it from a server-side job

```ts sample
import { payloadSize } from '@spinajs/http-socket';

const LIMIT = 1024 * 1024;

export function fitsOneFrame(payload: unknown): boolean {
  // the same measure the size stage applies: JSON bytes plus binary parts
  return payloadSize(payload) <= LIMIT;
}

console.log(fitsOneFrame({ id: 'img-1', data: new Uint8Array(512 * 1024) }));
// true
```

## Related

- [Command pipeline](04-command-pipeline.md): where stages 100 to 300 sit.
- [Stream replies](06-stream-replies.md): stream credit and stream slots.
- [Configuration](15-configuration.md): the schema checks of these keys.
- [Observability](16-observability.md): refusals in `socket_commands_total`.
