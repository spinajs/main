import type { Unbox } from '@spinajs/orm';

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /** @spinajs authz-scope accessible */
    accessible(): this;
    /** @spinajs authz-scope unscoped */
    unscoped(): this;
    stream(options?: { batchSize?: number }): AsyncIterable<Unbox<T>>;
  }
}
