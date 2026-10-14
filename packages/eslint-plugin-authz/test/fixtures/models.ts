export function AccessResource(_type: string): ClassDecorator {
  return () => undefined;
}

export function Primary(): PropertyDecorator {
  return () => undefined;
}

export const SYSTEM = { type: 'system', id: 'system' };

export declare function runAs<T>(principal: unknown, reason: string, fn: () => Promise<T>): Promise<T>;

export declare function authz(): { runAs: typeof runAs };

export interface Query<T> extends PromiseLike<T[]> {
  where(column: string, value: unknown): Query<T>;
  accessible(permission: string): Query<T>;
  unscoped(reason: string): Query<T>;
  populate(relation: string): Query<T>;
  take(count: number): Query<T>;
  first(): Promise<T>;
  firstOrFail(): Promise<T>;
  all(): Promise<T[]>;
  execute(): Promise<T[]>;
}

export declare class Model {
  static where<M extends typeof Model>(this: M, column: string, value: unknown): Query<InstanceType<M>>;
  static query<M extends typeof Model>(this: M): Query<InstanceType<M>>;
  static all<M extends typeof Model>(this: M): Query<InstanceType<M>>;
  static get<M extends typeof Model>(this: M, pk: unknown): Promise<InstanceType<M>>;
  static findOrFail<M extends typeof Model>(this: M, pks: unknown[]): Promise<InstanceType<M>[]>;
  static count(): Promise<number>;
  static create<M extends typeof Model>(this: M, data: Partial<InstanceType<M>>): Promise<InstanceType<M>>;
  static destroy(pk: unknown): Promise<void>;
}

@AccessResource('task')
export class Task extends Model {
  @Primary()
  public id!: number;
}

export class SubTask extends Task {}

export class Note extends Model {
  public id!: number;
}

export const models = { Task, Note };
