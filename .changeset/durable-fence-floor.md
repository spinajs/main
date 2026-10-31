---
"@spinajs/http-socket-client": patch
---

A durable queue no longer stalls for good on a fenced command whose predecessor already answered. The floor timer could fire just before `Date.now()` reached the floor, and then nothing woke the queue.
