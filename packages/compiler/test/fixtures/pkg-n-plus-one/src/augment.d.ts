import type { Unbox } from '@spinajs/orm';

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    accessible(): this;
    unscoped(): this;
    stream(options?: { batchSize?: number }): AsyncIterable<Unbox<T>>;
  }
}
