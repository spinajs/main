import { DI } from '@spinajs/di';

const MODEL_DESCRIPTOR_SYMBOL = Symbol.for('MODEL_DESCRIPTOR');

// RelationType.Many / .ManyToMany — array-valued relations. Numeric values of the
// orm enum, inlined to avoid a hard @spinajs/orm dependency.
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
 * Resolve an ORM model name to its column schema (built by the ORM on the
 * descriptor, honouring `@Ignore`) plus its relations tagged as named objects
 * (`description: <Target>`) — the dispatcher turns those into `$ref`s, so cycles
 * (campaign → offer → campaign) collapse to a reference instead of recursing.
 * Returns undefined for names that aren't a registered model. No hard
 * @spinajs/orm dependency: reads the `'__models__'` registry and the global
 * descriptor symbol.
 */
export function resolveModelSchema(typeName: string): Record<string, unknown> | undefined {
  const model = DI.getRegisteredTypes('__models__').find((m) => m.name === typeName);
  if (!model) {
    return undefined;
  }

  const descriptor = (Reflect.getMetadata(MODEL_DESCRIPTOR_SYMBOL, model) as Record<string, IModelDescriptorLite> | undefined)?.[typeName];
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
    const ref = { type: 'object', description: target };
    properties[relationName] = relation.Type !== undefined && TO_MANY_RELATION.has(relation.Type) ? { type: 'array', items: ref } : ref;
  });

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (columns.required && columns.required.length > 0) {
    schema.required = columns.required;
  }
  return schema;
}
