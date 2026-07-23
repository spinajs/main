import 'reflect-metadata';
import { getInheritedDescriptor } from '@spinajs/di';
import { ModelBase } from '@spinajs/orm';
import { ArgHydrator, IRouteParameter } from '@spinajs/http';

/**
 * Global symbol (shared via the global registry) under which a DTO's relation
 * descriptors are stored on its prototype. Global so `http-swagger` can read it
 * without importing this package.
 */
export const RELATION_SYMBOL = Symbol.for('orm-http:relations');

export interface IDtoRelationDescriptor {
  field: string;
  target: () => typeof ModelBase;
  by?: string;
}

export interface IDtoRelations {
  Relations: Map<string, IDtoRelationDescriptor>;
}

export interface IRelationOptions {
  /** Natural-key column on the target model to look the entity up by. Defaults to the target's primary key. */
  by?: string;
}

/**
 * Marks a DTO field as a reference to a DB entity. On an incoming request the
 * field value is looked up on `target` by `by` (or the target's primary key),
 * 404 if missing, and the field is replaced with the resolved model instance.
 */
export function Relation(target: () => typeof ModelBase, options?: IRelationOptions): PropertyDecorator {
  return (proto: object, propertyKey: string | symbol) => {
    const field = String(propertyKey);
    const descriptor = getInheritedDescriptor<IDtoRelations>(proto, RELATION_SYMBOL, () => ({ Relations: new Map() }));
    descriptor.Relations.set(field, { field, target, by: options?.by });

    // Register the resolver as the DTO's arg hydrator so a plain @Body() picks
    // it up through the existing hydrator hook — unless one is already set.
    const ctor = (proto as any).constructor;
    if (!Reflect.getOwnMetadata('custom:arg_hydrator', ctor)) {
      Reflect.defineMetadata('custom:arg_hydrator', { hydrator: RelationResolverHydrator }, ctor);
    }
  };
}

/**
 * Resolves a DTO's @Relation fields against the DB. Stub for Task 2 — builds and
 * returns the DTO instance. Task 3 adds resolution + schema enforcement.
 */
export class RelationResolverHydrator extends ArgHydrator {
  public async hydrate(input: any, parameter: IRouteParameter): Promise<any> {
    const ctor = parameter.RuntimeType as any;
    return new ctor(input);
  }
}
