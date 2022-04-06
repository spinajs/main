import { IWhereBuilder } from './interfaces';

export type WhereFunction<T> = (this: IWhereBuilder<T>) => void;

export type Unbox<T> = T extends Array<infer U> ? U : T;
