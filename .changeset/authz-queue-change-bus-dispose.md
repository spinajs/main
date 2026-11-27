---
"@spinajs/authz-queue": patch
---

`QueueChangeBus` now ends with the container that resolved it: `DI.dispose()` (or `dispose()` of that container) stops its `AuthzChangeEvent` consumer and its listen retry, also on a bus that only published. Before, `Container.dispose()` skipped the bus because it is not a `Service`, so the consumer and the retry timer outlived the application. A `publish` after `dispose()` is refused with `InvalidOperation` instead of starting to consume again; the local subscribers were already cleared by `dispose()`.
