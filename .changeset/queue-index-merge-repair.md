---
"@spinajs/queue": patch
---

`@spinajs/queue` builds again: `consume` runs the event deduplication and delivery contract changes inside the consumer span once, and `emit` publishes a message outside an outbox transaction through `publishDirect` under its producer span again (a branch merge had dropped both, so such a message was never sent).
