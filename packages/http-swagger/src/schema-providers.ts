import { DI, Injectable } from "@spinajs/di";
import { SCHEMA_SYMBOL } from "@spinajs/validation";

const MODEL_DESCRIPTOR_SYMBOL = Symbol.for("MODEL_DESCRIPTOR");

const TO_MANY_RELATION = new Set<number>([1, 2]);

interface IRelationLite {
  Type?: number;
  TargetModel?: { name?: string };
}

interface IModelDescriptorLite {
  Schema?: { properties?: Record<string, unknown>; required?: string[] };
  Relations?: Map<string, IRelationLite>;
}

/**
 * Resolves a type name to its JSON schema. Each provider handles one kind of type
 * and returns undefined for names it doesn't recognise.
 */
export abstract class SchemaProvider {
  public abstract resolve(
    typeName: string,
  ): Record<string, unknown> | undefined;
}

/**
 * Returns the schema for `typeName` from the first provider that recognises it.
 * Providers are discovered through DI, so a new kind plugs in by registering one.
 */
export function resolveTypeSchema(
  typeName: string,
): Record<string, unknown> | undefined {
  for (const provider of DI.resolve(Array.ofType(SchemaProvider))) {
    const schema = provider.resolve(typeName);
    if (schema) {
      return schema;
    }
  }
  return undefined;
}

/**
 * Resolves an ORM model name to its column schema plus relations. Reads the model's
 * descriptor and registry without a hard `@spinajs/orm` dependency.
 */
@Injectable(SchemaProvider)
export class ModelSchemaProvider extends SchemaProvider {
  public resolve(typeName: string): Record<string, unknown> | undefined {
    const model = DI.getRegisteredTypes("__models__").find(
      (m) => m.name === typeName,
    );
    if (!model) {
      return undefined;
    }

    const descriptor = (
      Reflect.getMetadata(MODEL_DESCRIPTOR_SYMBOL, model) as
        | Record<string, IModelDescriptorLite>
        | undefined
    )?.[typeName];
    const columns = descriptor?.Schema;
    if (!columns || !columns.properties) {
      return undefined;
    }

    const properties: Record<string, unknown> = { ...columns.properties };
    descriptor?.Relations?.forEach((relation, relationName) => {
      const target = relation?.TargetModel?.name;
      if (!target) {
        return;
      }
      const ref = { type: "object", description: target };
      properties[relationName] =
        relation.Type !== undefined && TO_MANY_RELATION.has(relation.Type)
          ? { type: "array", items: ref }
          : ref;
    });

    const schema: Record<string, unknown> = { type: "object", properties };
    if (columns.required && columns.required.length > 0) {
      schema.required = columns.required;
    }
    return schema;
  }
}

/**
 * Resolves a `@Schema`-decorated DTO name to the schema stored on the class. The
 * class is found via the `'__schemas__'` registry that `@Schema` populates.
 */
@Injectable(SchemaProvider)
export class DtoSchemaProvider extends SchemaProvider {
  public resolve(typeName: string): Record<string, unknown> | undefined {
    const dto = DI.getRegisteredTypes("__schemas__").find(
      (d) => d.name === typeName,
    );

    if (!dto) {
      return undefined;
    }

    const target = (dto as { prototype?: object }).prototype ?? dto;
    const schema = Reflect.getMetadata(SCHEMA_SYMBOL, target);
    return schema && typeof schema === "object"
      ? (schema as Record<string, unknown>)
      : undefined;
  }
}
