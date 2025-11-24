import { IWhereBuilder } from './interfaces.js';
import { Relation, SingleRelation } from './relation-objects.js';
 

export type WhereFunction<T> = (this: IWhereBuilder<T>) => void;

export type Unbox<T> = T extends Array<infer U> ? U : T;

export type UnboxRelation<T> = T extends Relation<infer U, any, any> ? U[] : T extends SingleRelation<infer Z> ? Z : never;
export type UnboxRelationWithModelDataSearchable<T> = T extends Relation<infer U, any, any> ? Omit<ModelDataWithRelationData<U>, ExcludedModelProperties>[] : T extends SingleRelation<infer Z> ? Omit<ModelDataWithRelationData<Z>, ExcludedModelProperties> | number : T;
export type UnboxRelationWithModelData<T> = T extends Relation<infer U, any, any> ? Omit<ModelDataWithRelationData<U>, ExcludedModelProperties>[] : T extends SingleRelation<infer Z> ? Omit<ModelDataWithRelationData<Z>, ExcludedModelProperties> : T;

export type PickRelations<T> = {
  [P in keyof T as T[P] extends Relation<any, any, any> | SingleRelation<any> ? P : never]: UnboxRelation<T[P]>;
};

export type PickRelationsWithModelDataSearchable<T> = {
  [P in keyof T as T[P] extends Relation<any, any, any> | SingleRelation<any> ? P : never]: UnboxRelationWithModelDataSearchable<T[P]>;
};
export type PickRelationsWithModelData<T> = {
  [P in keyof T as T[P] extends Relation<any, any, any> | SingleRelation<any> ? P : never]: UnboxRelationWithModelData<T[P]>;
};

export type PartialModel<T> = { [P in keyof T]?: T[P] extends SingleRelation<infer W> ? W : T[P] | undefined };
export type NonFunctionAndRelationPropertyNames<T> = { [K in keyof T]: T[K] extends Function | Relation<any, any, any> | SingleRelation<any> ? never : K }[keyof T];
export type NonFunctionPropertyNames<T> = { [K in keyof T]: T[K] extends Function ? never : K }[keyof T];

export type ExcludedModelProperties = 'PrimaryKeyValue' | 'PrimaryKeyName' | 'ModelDescriptor' | 'Container' | 'JunctionModelProps';
export type ModelData<T> = Omit<Pick<T, NonFunctionAndRelationPropertyNames<T>>, ExcludedModelProperties>;
export type ModelDataWithRelationData<T> = Omit<Pick<T, NonFunctionAndRelationPropertyNames<T>>, ExcludedModelProperties> & PickRelationsWithModelData<T>;
export type ModelDataWithRelationDataSearchable<T> = Omit<Pick<T, NonFunctionAndRelationPropertyNames<T>>, ExcludedModelProperties> & PickRelationsWithModelDataSearchable<T>;

export type PartialArray<T> = {
  [P in keyof T]: T[P] | T[P][];
};