import { NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { OrmNotFoundException } from '../exceptions.js';
import type { ICompilerOutput, ILimitBuilder, IQueryLimit } from '../interfaces.js';
import { _check_arg, _positive } from '@spinajs/util';
import type { SelectQueryBuilder } from './select.js';

@NewInstance()
export class LimitBuilder<T> implements ILimitBuilder<T> {
  protected _first: boolean;
  protected _limit: IQueryLimit;

  constructor() {
    this._first = false;
    this._limit = {
      limit: -1,
      offset: -1,
    };
  }

  public take(count: number) {
    _check_arg(_positive())(count, 'take count');

    this._limit.limit = count;
    return this;
  }

  public skip(count: number) {
    if (count < 0) {
      throw new InvalidArgument(`skip count cannot be negative number`);
    }

    this._limit.offset = count;
    return this;
  }

  public takeFirst() {
    this._first = true;
    this._limit.limit = 1;

    return this;
  }

  public async first() {
    return (await this.takeFirst()) as any;
  }

  public async firstOrFail() {
    return this.firstOrThrow((output: ICompilerOutput) => new OrmNotFoundException(`Database entry not found for the given query.`, undefined, output.expression ?? undefined, output.bindings ?? undefined));
  }

  public async orThrow(error: Error | ((output: ICompilerOutput) => Error)) {
    const result = (await this) as any;
    if (result === undefined || (Array.isArray(result) && result.length === 0)) {
      if (typeof error === 'function') {
        throw error(
          (this as unknown as SelectQueryBuilder).toDB()
        );
      } else
        throw error;
    }

    return result;
  }

  public async firstOrThrow(error: Error | ((output: ICompilerOutput) => Error)) {
    const result = await this.first();
    if (result === undefined) {

      if (typeof error === 'function') {
        throw error(
          (this as unknown as SelectQueryBuilder).toDB()
        );
      } else
        throw error;
    }

    return result;
  }

  public getLimits() {
    return this._limit;
  }
}
