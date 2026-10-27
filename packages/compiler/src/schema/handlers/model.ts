import ts from 'typescript';
import { isModelType, isRelationType, modelMembers, ORM, type ModelMember } from '../../model-members.js';
import { deriveType, diagnose, type DeriveContext, type JsonSchema, type TypeHandler } from '../derive.js';
import { baseClassOf, declaringPackage, extendsFrameworkClass, isDeclaredIn } from '../framework-members.js';
import { includesUndefined, propertyConstraints } from './object.js';

const MODEL_DATA = new Set(['ModelData', 'ModelDataWithRelationData', 'ModelDataWithRelationDataSearchable']);

function firstTypeArgument(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  return isReference ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
}

/** A `Relation<M>` member is an array of M, a `SingleRelation<M>` one is M; a decorated member typed as the model itself is M too. */
function relationSchema(ctx: DeriveContext, type: ts.Type): JsonSchema {
  if (!isRelationType(ctx.checker, type)) return deriveType(ctx, type);
  const target = firstTypeArgument(ctx.checker, type);
  const schema = target ? deriveType(ctx, target) : {};
  return extendsFrameworkClass(ctx.checker, type, 'Relation', ORM) ? { type: 'array', items: schema } : schema;
}

function memberSchema(ctx: DeriveContext, member: ModelMember): { schema: JsonSchema; required: boolean } {
  const memberContext: DeriveContext = { ...ctx, node: member.declaration };
  // A relation is dehydrated only when populated, so it is never required.
  if (member.kind === 'relation') return { schema: relationSchema(memberContext, ctx.checker.getNonNullableType(member.type)), required: false };
  return {
    schema: { ...deriveType(memberContext, member.type), ...propertyConstraints(memberContext, member.symbol, member.declaration) },
    required: !member.optional && !includesUndefined(member.type),
  };
}

/** The first class from the model up to ModelBase that is read from a declaration file, where decorators are gone. */
function declarationFileClass(checker: ts.TypeChecker, type: ts.Type): ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Type | undefined = type; current; current = baseClassOf(checker, current)) {
    const declaration = current.getSymbol()?.declarations?.find(ts.isClassLike);
    if (!declaration || (declaration.name?.text === 'ModelBase' && isDeclaredIn(declaration, ORM))) return undefined;
    if (declaration.getSourceFile().isDeclarationFile) return declaration;
  }
  return undefined;
}

/** Without decorators a closed column list would publish `@Hidden` columns (a password hash), so it fails open. */
function opaqueModel(ctx: DeriveContext, type: ts.Type): JsonSchema | undefined {
  const opaque = declarationFileClass(ctx.checker, type);
  if (!opaque) return undefined;
  const model = type.getSymbol()?.name ?? ctx.checker.typeToString(type);
  const base = opaque.name?.text ?? 'its base class';
  const subject = base === model ? `model ${model} is` : `model ${model} extends ${base},`;
  diagnose(ctx, 'SCH001', 'info', `${subject} read from a declaration file of ${declaringPackage(opaque)}, where @Hidden columns are invisible; emitted as an open object`);
  return { type: 'object' };
}

/** An ORM model derives to the columns and relations `modelMembers` lists, `@Hidden` and computed ones left out. */
export const modelType: TypeHandler = (ctx, type) => {
  if (!isModelType(ctx.checker, type)) return undefined;
  const opaque = opaqueModel(ctx, type);
  if (opaque) return opaque;
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const member of modelMembers(ctx.checker, type)) {
    if (member.kind === 'computed' || member.hidden) continue;
    const { schema, required: isRequired } = memberSchema(ctx, member);
    properties[member.name] = schema;
    if (isRequired) required.push(member.name);
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
  return model && isModelType(ctx.checker, model) ? deriveType(ctx, model) : undefined;
};
