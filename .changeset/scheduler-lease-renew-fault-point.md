---
'@spinajs/scheduler': minor
---

The run heartbeat calls `FaultInjector.point('scheduler.lease-renew')` before renewing the lease. It is a no-op (`NoFaults`) outside `@spinajs/simulation`.
