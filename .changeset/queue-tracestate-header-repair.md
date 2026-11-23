---
"@spinajs/queue": patch
---

`@spinajs/queue` builds again: `QueueHeaders.TraceState` (`tracestate`) is back next to `QueueHeaders.Tenant`. A branch merge had dropped the name while `emit` still strips it from a re-emitted message.
