# Streams

`query.stream()` reads a large result without holding it in memory. Rows arrive one batch at a time. Each batch is hydrated, and its relations are populated, the same way `await query` does it, so a stream with `populate()` runs one relation query per batch, not one per row.

```ts
for await (const order of Order.where('Status', 'open').order('Id').populate('Items').stream({ batchSize: 200 })) {
  await ship(order);
}
```

- `batchSize` (default 500) is the number of rows hydrated and populated per round.
- Leaving the loop early (`break`, `return`, a throw) releases the cursor and the pooled connection.
- An error from the database or from hydration rejects the loop at the row where it happened.
- Inside `transaction()` the stream sees the transaction's own writes, but it never uses a server cursor there: it pages by keyset (below), so it needs an `order()` and a model with a primary key. A cursor would hold the transaction's connection, and the per-batch relation load or any statement in the loop body would wait for it for ever.
- A query middleware that asks for a transaction (`QueryMiddleware.transactional()`) also pages by keyset; each page runs in its own short transaction. Open the transaction around the loop when the whole stream must be one.
- `stream()` cannot follow `first()`.

## Drivers

| Driver | How it reads |
|---|---|
| sqlite | Steps one prepared statement. On the writer handle (the only handle of a `:memory:` database), a stream opened outside a transaction holds `BEGIN` back until it ends, as any statement in progress does: do not `await driver.transaction()` inside the loop body of such a stream, because the transaction waits for the stream and the stream waits for the loop. Collect the batch and open the transaction after the loop, or open it around the loop. |
| any driver without a cursor | Pages by keyset (below) |
| every driver, inside `transaction()` | Pages by keyset (below) |

A driver that has a cursor sets `supportedFeatures().streaming` and implements `executeStreamOnDb(stmt, params, { batchSize })`.

## Without a cursor: keyset pages

On a driver without a cursor, and inside a transaction on every driver, `stream()` runs one select per batch and continues past the last row of the previous batch (`WHERE (a > ?) OR (a = ? AND b > ?) …`). This needs:

- an `order()` on the query. Without one, `stream()` throws `StreamNotSupported`;
- a model with a primary key, which is appended to the order as the tie-breaker;
- no `take()`, `skip()` or order by a relation column;
- NOT NULL order columns. The check reads the table description before the first page and throws `InvalidArgument` for a nullable column, because the dialects do not agree on where NULLs sort (first ascending on sqlite and mysql, last on postgres) and a walk would fail only when it reached them.

Rows inserted or changed while the stream runs may or may not appear, depending on where they sort. A row present for the whole stream appears exactly once.
