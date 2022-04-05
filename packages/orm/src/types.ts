import { IWhereBuilder } from './interfaces';

export type WhereFunction = (this: IWhereBuilder<any>) => IWhereBuilder<any>;

export type Unbox<T> = T extends Array<infer U> ? U : T;
