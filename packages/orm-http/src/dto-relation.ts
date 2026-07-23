import 'reflect-metadata';
import { getInheritedDescriptor } from '@spinajs/di';
import { ModelBase, OrmNotFoundException } from '@spinajs/orm';
import { ArgHydrator, IRouteParameter } from '@spinajs/http';
import { SCHEMA_SYMBOL } from '@spinajs/validation';
import { InvalidOperation } from '@spinajs/exceptions';

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

const schemaChecked = new WeakSet<object>();

/** Enforces the rule: a DTO using @Relation must declare a @Schema. */
function assertDtoHasSchema(ctor: any): void {
  if (schemaChecked.has(ctor)) return;
  const schema = Reflect.getMetadata(SCHEMA_SYMBOL, ctor.prototype) ?? Reflect.getMetadata(SCHEMA_SYMBOL, ctor);
  if (!schema) {
    throw new InvalidOperation(`DTO ${ctor.name} uses @Relation but has no @Schema. All DTOs with @Relation must declare a @Schema.`);
  }
  schemaChecked.add(ctor);
}

/**
 * Resolves a DTO's @Relation fields against the DB. Enforces that any DTO with a
 * @Relation declares a @Schema, resolves each present relation field to a model
 * instance (404 if not found), and leaves absent/null fields untouched.
 */
export class RelationResolverHydrator extends ArgHydrator {
  public async hydrate(input: any, parameter: IRouteParameter): Promise<any> {
    const ctor = parameter.RuntimeType as any;
    const dto = new ctor(input);

    const relDesc = Reflect.getMetadata(RELATION_SYMBOL, ctor.prototype) as IDtoRelations | undefined;
    if (!relDesc || relDesc.Relations.size === 0) {
      return dto;
    }

    // Enforce "every @Relation DTO must have a @Schema" once per class.
    assertDtoHasSchema(ctor);

    await Promise.all(
      [...relDesc.Relations.values()].map(async (rel) => {
        const value = (dto as any)[rel.field];

        // Absent / null: optional fields are skipped; required fields were
        // already rejected upstream by @Schema validation.
        if (value === undefined || value === null) {
          return;
        }

        const model = rel.target();
        const by = rel.by ?? model.getModelDescriptor().PrimaryKey;
        const resolved = await (model as any)
          .where({ [by]: value })
          .firstOrThrow(new OrmNotFoundException(`${model.name} referenced by '${rel.field}' not found`));

        (dto as any)[rel.field] = resolved;
      }),
    );

    return dto;
  }
}
