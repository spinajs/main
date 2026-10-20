/** @internal What a write passes for a model's columns: a nullable column takes `null`, which its property type leaves out. */
export type ColumnValues<M> = { [K in keyof M]?: M[K] | null };

/** @internal `values` typed as the ORM's write methods take them. */
export function columnValues<M>(values: ColumnValues<M>): Partial<M> {
  return values as Partial<M>;
}
