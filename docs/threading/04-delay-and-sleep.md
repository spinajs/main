# Delay and sleep

`delay(duration, callback)` runs a callback after `duration` milliseconds and resolves with its result. `sleep(duration)` waits `duration` milliseconds and resolves with nothing.

Both use `setTimeout`, so they hold no thread and no lock. They are timers, not schedulers: nothing survives a restart.

## How it works

`delay<T>(duration: number, callback: () => T): Promise<T>`:

1. Starts `setTimeout(..., duration)`.
2. When the timer fires, calls `callback()`.
3. A plain value resolves the promise with it. A returned promise is followed: it resolves or rejects the result.
4. A synchronous throw rejects the promise.

`sleep(duration: number): Promise<void>` calls `sleep()` from `@spinajs/util` with the number of milliseconds. A negative duration waits `0` ms.

## Important behaviour

- The callback runs on a later macrotask, never synchronously, even with `duration` `0`.
- `delay()` cannot be cancelled: the timer has no handle you can reach. Check a flag inside the callback if you need to skip work.
- `sleep()` here takes milliseconds only. `sleep()` from `@spinajs/util` also takes a `TimeSpan` or a duration string.
- Both keep the Node.js event loop alive until the timer fires.

## Best practices

- Prefer `delay()` over `sleep()` followed by a call when you need the result: one promise carries both the wait and the outcome.
- Use [`rateLimit()`](03-critical-section-and-rate-limit.md) when spacing applies to calls from several places under one name; use `delay()` for one call.

## Examples

### Retry a webhook with growing pauses

```ts sample
import { delay } from '@spinajs/threading';

export async function deliverWebhook(send: () => Promise<number>, attempts = 4): Promise<number> {
  let status = await send();

  for (let attempt = 1; attempt < attempts && status >= 500; attempt++) {
    status = await delay(500 * 2 ** attempt, send);
  }

  return status;
}
```

### Poll a payment until it settles

```ts sample
import { sleep } from '@spinajs/threading';

type PaymentState = 'pending' | 'paid' | 'failed';

export async function waitForPayment(readState: () => Promise<PaymentState>, timeoutMs = 30_000): Promise<PaymentState> {
  const deadline = Date.now() + timeoutMs;
  let state = await readState();

  while (state === 'pending' && Date.now() < deadline) {
    await sleep(1_000);
    state = await readState();
  }

  return state;
}
```

## Related

- [Critical section and rate limit](03-critical-section-and-rate-limit.md): `rateLimit()` waits with `delay()`.
- [Named mutex](01-named-mutex.md): `mutex_wait()` waits for a lock instead of a fixed time.
