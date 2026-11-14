/**
 * Bet 3 D17 routes a select outside a transaction to a read replica; a read that decides a claim must see the
 * primary. No-op until Bet 3 O10 (`v4-o-10-replicas`) ships `ISelectQueryBuilder.onPrimary()`: then this calls it,
 * and the shim goes once every caller uses the builder method.
 */
export function onPrimary<T extends object>(query: T): T {
  const builder = query as T & { onPrimary?: () => T };
  return typeof builder.onPrimary === 'function' ? builder.onPrimary() : query;
}
