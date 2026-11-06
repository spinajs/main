import { NewInstance, IContainer } from '@spinajs/di';
import _ from 'lodash';
import { ICompilerOutput } from '../interfaces.js';
import { RawQuery } from './raw.js';
import { QueryBuilder } from './base.js';

@NewInstance()
export class OnDuplicateQueryBuilder {
  protected _column: string[];

  protected _parent: QueryBuilder;

  protected _columnsToUpdate!: Array<string | RawQuery>;

  protected _container: IContainer;

  protected _returning: string[];

  constructor(container: IContainer, insertQueryBuilder: QueryBuilder, column?: string | string[], returning?: string[]) {
    this._parent = insertQueryBuilder;
    this._container = container;

    this._column = _.isArray(column) ? column : (column !== undefined ? [column] : []);
    this._returning = returning ?? ['*'];
  }

  public getReturning(): string[] {
    return this._returning;
  }

  public getColumn(): string[] {
    return this._column;
  }

  public getColumnsToUpdate() {
    return this._columnsToUpdate;
  }

  public getParent() {
    return this._parent;
  }

  public update(columns: string[] | RawQuery[]) {
    this._columnsToUpdate = columns;
    return this;
  }

  public execute(): Promise<any> {
    return this._parent.execute();
  }

  public then<TResult1, TResult2 = never>(onfulfilled?: ((value: any) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return this._parent.then(onfulfilled, onrejected);
  }

  public toDB(): ICompilerOutput | ICompilerOutput[] {
    return this._parent.toDB();
  }
}
