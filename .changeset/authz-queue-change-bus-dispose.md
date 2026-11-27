---
"@spinajs/authz-queue": patch
---

`QueueChangeBus` now ends with the container that resolved it: `DI.dispose()` (or `dispose()` of that container) stops its `AuthzChangeEvent` consumer and its listen retry, also on a bus that only published. Before, `Container.dispose()` skipped the bus because it is not a `Service`, so the consumer and the retry timer outlived the application. A `publish` after `dispose()` is refused with `InvalidOperation` instead of starting to consume again, and a `subscribe` after `dispose()` throws `InvalidOperation`, so a disposed bus has no local subscriber left to hear a change. A start that fails after `dispose()` no longer logs "cannot listen on the queue, retrying".
