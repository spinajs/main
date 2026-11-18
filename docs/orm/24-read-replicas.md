# Read replicas

A connection can list read-only copies of itself. Model selects go to a healthy replica, in turn. Writes, schema changes and migrations always run on the primary.

```json
{
  "db": {
    "Connections": [
      {
        "Name": "main",
        "Driver": "orm-driver-postgres",
        "Host": "db-primary",
        "Database": "app",
        "Replicas": [{ "Host": "db-replica-1" }, { "Host": "db-replica-2" }],
        "ReadPreference": "replica",
        "StickyPrimary": "context"
      }
    ]
  }
}
```

Each replica entry is merged over the primary's options (a nested `Options` object replaces the primary's as a whole) and opened as its own driver named `main:replica:<n>`. An entry may not name another `Driver`: that fails the boot. `Orm.Replicas.get('main')` lists them. A replica that is down at boot does not fail the boot: it is logged, its selects go to the primary, and its health check keeps reconnecting.

## Which select reads the primary

A model select reads the primary instead of a replica when:

- the select calls `.onPrimary()`;
- it locks rows (`forUpdate()`, `forShare()`);
- it runs inside a `transaction()` on that connection;
- `ReadPreference` is `primary`;
- no replica is healthy, which means connected and answering its health check (`Resilience.HealthCheckInterval`);
- `StickyPrimary` is `context` (the default) and the current read-your-writes scope has already written through the connection;
- it runs in a migration: `up()`, `down()` and the `data()` seeds the migrator runs, with or without a transaction.

A raw `driver.select()` runs on the driver it was taken from, and the replica router never sees it. `stream()` and `paginate()` follow the same rules. One stream reads every page from the connection it picked first. `paginate()` picks a connection per call, so the pages a client walks across requests may come from different replicas, each with its own lag.

Relations loaded with `populate()` that run their own select (one-to-many, many-to-many, query relations) read the connection their owner's rows came from: the replica the owner's select read, the primary under `.onPrimary()`, and the stream's connection for every batch of a stream. Nested relations follow the same connection. A belongs-to relation is a JOIN in the owner's select and reads the same connection anyway. Inside a read-your-writes scope that wrote, or in a transaction, every relation reads the primary like the select that loaded it; that also holds for a select that opens a transaction or writes while relations load. A relation load leaves a replica that is no longer healthy and is routed like any other select. A relation whose model lives on another connection is routed on its own.

On PostgreSQL and MySQL, a select that a replica cannot answer moves once. The driver first retries on the replica's own connection (`Resilience.MaxRetries`, with backoff); when those retries run out it marks the replica disconnected, and the select runs again where the router sends it now: another healthy replica, or the primary. Give the replica entries `Resilience: { MaxRetries: 0 }` to move on the first lost connection instead of after the backoff. A statement the replica refused (a SQL error) is not run again anywhere, also while the replica is degraded. A stream does not move: it reads every page from the connection it picked first and fails with it. The replica's health check reconnects it in the background.

The SQL Server driver does not retry a lost connection and never marks a replica disconnected, and neither does SQLite, which has no connection to lose. On those a select routed to a lost replica fails, until the replica's health check (`Resilience.HealthCheckInterval`) takes it out of the rotation and selects go elsewhere.

## Read-your-writes

`readYourWrites(fn)` runs `fn` in a scope. Once a statement in the scope writes through a connection, the scope's later selects on that connection read the primary, so a request does not miss its own write because a replica lags behind. `@spinajs/orm-http` opens one scope per HTTP request (`ReadYourWritesScope`). Queue consumers, scheduled jobs and scripts that write and then read wrap the work themselves:

```ts
await readYourWrites(async () => {
  await order.update();
  return Order.where('Id', order.Id).firstOrFail(); // the primary
});
```

Outside any scope a write pins nothing, and the next select reads a replica.

Every builder other than a select marks the scope when it runs: a model's `insert()`, `update()`, `destroy()`, `save()`, the `driver.insert()`/`update()`/`del()` builders, schema builders and the typed `sql` helper (`executeSql`, which also marks it for a fragment that only reads). Only a statement sent through `driver.executeOnDb()`, or a builder handed straight to `driver.execute(builder)`, bypasses it, so a request that writes that way and then reads through a model still reads a replica unless the read calls `.onPrimary()`.

## Session settings and row-level security

A replica driver is resolved like its primary, so every registered `ConnectionSessionSettings` provider (for example the row-level security settings of `@spinajs/authz-orm`) applies to the statements it runs, in a transaction of their own as on the primary. The policies themselves come with the replica: a physical replica holds the primary's schema, policies included. A logical replica, or any copy that does not carry the policies, would answer every row.

## Custom routing

Register your own `ReplicaRouter` (`register`, `replicasOf`, `pick(primary, query)`) to choose replicas by other rules, for example by region or by lag. The builder asks the router of the container that booted the `Orm`. The relation loads of a select's rows read the connection the router picked for that select and do not call `pick` again, so a router that decides per query, or overrides `needsPrimary`, is not asked about them; they go back to the router only when that connection is no longer healthy, a transaction is open on the primary, or the read-your-writes scope has written through it.
