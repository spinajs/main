---
"@spinajs/tenancy-orm": minor
---

`TenantLifecycle.suspend(id, reason)` and `resume(id)`: the state and the reason (`row.suspensionRecord()`) are written in one statement conditioned on the state, neither waits for a lifecycle operation that holds the tenant nor writes its record, a second suspension is refused, and a tenant whose deletion started is never resumed. `TenantModel.writeSuspension(to, suspension)`.
