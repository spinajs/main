import { IWhereBuilder } from './interfaces';
import { Relation } from './relations';

export type WhereFunction<T> = (this: IWhereBuilder<T>) => void;

export type Unbox<T> = T extends Array<infer U> ? U : T;

export type UnboxRelation<T> = T extends Relation<infer U> ? U : T;

export type PickRelations<T, Value> = {
  [P in keyof T as T[P] extends Value | undefined ? P : never]: number | UnboxRelation<Value>;
};

export type PartialModel<T> = { [P in keyof T]?: T[P] extends Relation<infer W> ? W : T[P] | undefined };
