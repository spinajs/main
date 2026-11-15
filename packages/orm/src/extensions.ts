import type { Class, Constructor, IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import type { QueryBuilder } from './builders/base.js';
import type { OrmDriver } from './driver.js';
import type { ModelBase } from './model.js';
import type { IOrmRelation } from './relations.js';

/** What a query extension method reads from its builder through `state()`. */
export interface BuilderState {
  model: Constructor<ModelBase> | undefined;
  relations: IOrmRelation[];
  container: IContainer;
  owner: IOrmRelation | undefined;
  connection: OrmDriver;
}

/**
 * Adds methods to one query builder class. Subclass the base of that builder (`SelectQueryExtension`,
 * `InsertQueryExtension`, `UpdateQueryExtension`, `DeleteQueryExtension`) and register it with
 * `@Injectable(<that base>)`; `Orm.resolve()` installs every registered extension before it opens a
 * connection. A method name the builder already has, or that two extensions add to it, fails the boot
 * with `ExtensionMethodCollision`. A subclass of a registered extension replaces it. An extension for
 * several builders is several classes sharing one `methods` object.
 */
export abstract class QueryExtension {
  public abstract readonly name: string;
  public abstract readonly methods: Record<string, (this: QueryBuilder, ...args: any[]) => unknown>;
  public onClone?(source: QueryBuilder, clone: QueryBuilder): void;
}

/** Methods for `SelectQueryBuilder`; `onClone` runs when a select builder is cloned. */
export abstract class SelectQueryExtension extends QueryExtension {}
/** Methods for `InsertQueryBuilder`. */
export abstract class InsertQueryExtension extends QueryExtension {}
/** Methods for `UpdateQueryBuilder`. */
export abstract class UpdateQueryExtension extends QueryExtension {}
/** Methods for `DeleteQueryBuilder`. */
export abstract class DeleteQueryExtension extends QueryExtension {}

/** The builder a `defineQueryExtension` definition targets; the classes above carry this in their type instead. */
export type QueryTarget = 'select' | 'update' | 'delete' | 'insert';

export interface QueryExtensionDefinition {
  name: string;
  target: QueryTarget;
  methods: QueryExtension['methods'];
  onClone?(source: QueryBuilder, clone: QueryBuilder): void;
}

const BASES: Record<QueryTarget, abstract new () => QueryExtension> = {
  select: SelectQueryExtension,
  update: UpdateQueryExtension,
  delete: DeleteQueryExtension,
  insert: InsertQueryExtension,
};

/** A class extending the base `def.target` names, from a plain definition; register it with `DI.register(X).as(SelectQueryExtension)` (or the matching base). */
export function defineQueryExtension(def: QueryExtensionDefinition): Class<QueryExtension> {
  if (!Object.prototype.hasOwnProperty.call(BASES, def.target)) {
    throw new InvalidArgument(`query extension ${def.name} targets ${String(def.target)}; expected one of ${Object.keys(BASES).join(', ')}`);
  }
  const Base = BASES[def.target];

  class DefinedQueryExtension extends Base {
    public readonly name = def.name;
    public readonly methods = def.methods;

    public onClone(source: QueryBuilder, clone: QueryBuilder): void {
      def.onClone?.(source, clone);
    }
  }

  // DI caches instances by class name: two anonymous classes, or a select and an update definition
  // sharing one name, would share one instance.
  Object.defineProperty(DefinedQueryExtension, 'name', { value: `${Base.name}:${def.name}` });
  return DefinedQueryExtension;
}
