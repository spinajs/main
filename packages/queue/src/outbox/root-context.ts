import { AsyncLocalStorage } from 'node:async_hooks';

// A timer or an unawaited promise keeps the async context of the code that started it, and the outbox starts both from
// inside business transactions (QueueService resolves lazily, a nudge follows a commit). Taken at import, this is the
// context outside every transaction and request.
export const inRootContext = AsyncLocalStorage.snapshot();
