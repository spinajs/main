import ts from 'typescript';
import { decoratorsOf } from '../../decorators.js';
import { deriveType, type DeriveContext, type JsonSchema, type TypeHandler } from '../derive.js';
import { extendsFrameworkClass, isDeclaredIn } from '../framework-members.js';
import { includesUndefined, isCallable, isPublicMember, propertyConstraints } from './object.js';

const ORM = '@spinajs/orm';
const MODEL_DATA = new Set(['ModelData', 'ModelDataWithRelationData', 'ModelDataWithRelationDataSearchable']);
// Computed members and `@Hidden` columns never appear in a dehydrated model. Declaration files drop decorators, so
// this only applies to models whose source is in the program.
const NOT_SERIALIZED = new Set(['Virtual', 'Query', 'Historical', 'Hidden']);

interface Column {
  schema: JsonSchema;
  required: boolean;
}

const isModel = (checker: ts.TypeChecker, type: ts.Type): boolean => !!(type.flags & ts.TypeFlags.Object) && extendsFrameworkClass(checker, type, 'ModelBase', ORM);

/** ModelBase's own getters (Container, ModelDescriptor, ...) are ORM plumbing; columns start at its subclasses. */
function isModelBaseMember(declaration: ts.Declaration): boolean {
  const owner = declaration.parent;
  return ts.isClassLike(owner) && owner.name?.text === 'ModelBase' && isDeclaredIn(declaration, ORM);
}

function firstTypeArgument(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  return isReference ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
}

/** Recognized by type, not by decorator, so models read from declaration files keep their relations. */
function relationSchema(ctx: DeriveContext, type: ts.Type): JsonSchema | undefined {
  const many = extendsFrameworkClass(ctx.checker, type, 'Relation', ORM);
  if (!many && !extendsFrameworkClass(ctx.checker, type, 'SingleRelation', ORM)) return undefined;
  const target = firstTypeArgument(ctx.checker, type);
  const schema = target ? deriveType(ctx, target) : {};
  return many ? { type: 'array', items: schema } : schema;
}

function columnOf(ctx: DeriveContext, property: ts.Symbol): Column | undefined {
  if (property.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Signature)) return undefined;
  const declaration = property.valueDeclaration ?? property.declarations?.[0];
  if (!declaration || !isPublicMember(declaration) || isModelBaseMember(declaration)) return undefined;
  if (ts.canHaveDecorators(declaration) && decoratorsOf(declaration).some((d) => NOT_SERIALIZED.has(d.name))) return undefined;

  const type = ctx.checker.getTypeOfSymbolAtLocation(property, declaration);
  const columnContext: DeriveContext = { ...ctx, node: declaration };
  const relation = relationSchema(columnContext, ctx.checker.getNonNullableType(type));
  // A relation is dehydrated only when populated, so it is never required.
  if (relation) return { schema: relation, required: false };
  if (isCallable(ctx.checker, type)) return undefined;
  return {
    schema: { ...deriveType(columnContext, type), ...propertyConstraints(columnContext, property, declaration) },
    required: !(property.flags & ts.SymbolFlags.Optional) && !includesUndefined(type),
  };
}

/** An ORM model derives to its declared columns and relations, never through ModelBase internals or its index signature. */
export const modelType: TypeHandler = (ctx, type) => {
  if (!isModel(ctx.checker, type)) return undefined;
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

/** `ModelData<M>` and its relation variants are what `dehydrate()` returns for M: they derive as M itself. */
export const modelDataType: TypeHandler = (ctx, type) => {
  const alias = type.aliasSymbol;
  if (!alias || !MODEL_DATA.has(alias.name) || !isDeclaredIn(alias.declarations?.[0], ORM)) return undefined;
  const model = type.aliasTypeArguments?.[0];
  return model && isModel(ctx.checker, model) ? deriveType(ctx, model) : undefined;
};
