import ts from 'typescript';
import { decoratorsOf } from '../../decorators.js';
import { deriveType, type DeriveContext, type JsonSchema, type TypeHandler } from '../derive.js';
import { extendsFrameworkClass, isDeclaredIn } from '../framework-members.js';
import { includesUndefined, isCallable, isPublicMember, propertyConstraints } from './object.js';

const ORM = '@spinajs/orm';
const SINGLE_RELATIONS = new Set(['BelongsTo', 'ForwardBelongsTo']);
const MANY_RELATIONS = new Set(['HasMany', 'HasManyToMany']);
// Computed members and `@Hidden` columns never appear in a dehydrated model.
const NOT_SERIALIZED = new Set(['Virtual', 'Query', 'Historical', 'Hidden']);

interface Column {
  schema: JsonSchema;
  required: boolean;
}

/** ModelBase's own getters (Container, ModelDescriptor, ...) are ORM plumbing; columns start at its subclasses. */
function isModelBaseMember(declaration: ts.Declaration): boolean {
  const owner = declaration.parent;
  return ts.isClassLike(owner) && owner.name?.text === 'ModelBase' && isDeclaredIn(declaration, ORM);
}

/** `SingleRelation<T>`, `Relation<T, O>` and their subclasses carry the related model as the first type argument. */
function relationSchema(ctx: DeriveContext, type: ts.Type, many: boolean): JsonSchema {
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  const [target] = isReference ? ctx.checker.getTypeArguments(type as ts.TypeReference) : [];
  if (!target) return deriveType(ctx, type);
  const schema = deriveType(ctx, target);
  return many ? { type: 'array', items: schema } : schema;
}

function columnOf(ctx: DeriveContext, property: ts.Symbol): Column | undefined {
  if (property.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Signature)) return undefined;
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  if (!declaration || !isPublicMember(declaration) || isModelBaseMember(declaration)) return undefined;
  const decorators = ts.canHaveDecorators(declaration) ? decoratorsOf(declaration).map((d) => d.name) : [];
  if (decorators.some((name) => NOT_SERIALIZED.has(name))) return undefined;

  const type = ctx.checker.getTypeOfSymbolAtLocation(property, declaration);
  const columnContext: DeriveContext = { ...ctx, node: declaration };
  const relation = decorators.find((name) => SINGLE_RELATIONS.has(name) || MANY_RELATIONS.has(name));
  // A relation is dehydrated only when populated, so it is never required.
  if (relation) return { schema: relationSchema(columnContext, type, MANY_RELATIONS.has(relation)), required: false };
  if (isCallable(ctx.checker, type)) return undefined;
  return {
    schema: { ...deriveType(columnContext, type), ...propertyConstraints(columnContext, property, declaration) },
    required: !(property.flags & ts.SymbolFlags.Optional) && !includesUndefined(type),
  };
}

/** An ORM model derives to its declared columns and relations, never through ModelBase internals or its index signature. */
export const modelType: TypeHandler = (ctx, type) => {
  if (!(type.flags & ts.TypeFlags.Object) || !extendsFrameworkClass(ctx.checker, type, 'ModelBase', ORM)) return undefined;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const property of ctx.checker.getPropertiesOfType(type)) {
    const column = columnOf(ctx, property);
    if (!column) continue;
    properties[property.name] = column.schema;
    if (column.required) required.push(property.name);
  }
  const schema: JsonSchema = { type: 'object' };
  if (Object.keys(properties).length) schema.properties = properties;
  if (required.length) schema.required = required;
  schema.additionalProperties = false;
  return schema;
};
