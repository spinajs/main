---
"@spinajs/orm": minor
"@spinajs/orm-http": minor
---

Read replicas: `IDriverOptions.Replicas` opens one driver per entry (merged over the primary's options), `ReadPreference` (`replica` by default) and `StickyPrimary` (`context` by default) steer model selects. A select goes to a healthy replica, round robin, unless it calls `.onPrimary()`, locks rows, runs in a transaction, runs during a migration (`up`, `down` or `data()`), or its read-your-writes scope already wrote through the connection. `readYourWrites(fn)` opens such a scope and `@spinajs/orm-http` opens one per request (`ReadYourWritesScope`): importing `@spinajs/orm-http` now runs every request inside a new `AsyncLocalStorage` scope, also on connections without replicas, where it has no effect. Every builder other than a select marks the scope; `driver.executeOnDb()` does not. A replica entry must keep its primary's `Driver`. Raw `driver.select()` is never routed. `ReplicaRouter` is the DI seam for custom routing, resolved from the container that booted the Orm.
