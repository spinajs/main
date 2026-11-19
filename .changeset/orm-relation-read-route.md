---
"@spinajs/orm": patch
---

Relations loaded by `populate()` now read the connection their owner's rows came from: under `.onPrimary()` they read the primary, in a stream every batch's relations read the stream's connection, and a replica read loads its relations from the same replica, so owner and relations no longer come from replicas with different lag. A transaction, a write in a read-your-writes scope and an unhealthy replica still send the relation load where the router decides.
