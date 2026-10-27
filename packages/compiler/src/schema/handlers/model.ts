import ts from 'typescript';
import { declarationFileClass, isModelType, isRelationType, modelMembers, ORM, type ModelMember } from '../../model-members.js';
import { deriveType, diagnose, type DeriveContext, type JsonSchema, type TypeHandler } from '../derive.js';
import { baseClassOf, declaringPackage, extendsFrameworkClass, isDeclaredIn } from '../framework-members.js';
import { includesUndefined, propertyConstraints } from './object.js';

const MODEL_DATA = new Set(['ModelData', 'ModelDataWithRelationData', 'ModelDataWithRelationDataSearchable']);

function firstTypeArgument(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const isReference = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference;
  return isReference ? checker.getTypeArguments(type as ts.TypeReference)[0] : undefined;
}

/** A relation class without type parameters (`class Picks extends Relation<Book, Shelf>`) names its target on a base. */
function relationTarget(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  for (let current: ts.Type | undefined = type, hops = 0; current && hops < 32; current = baseClassOf(checker, current), hops++) {
    const target = firstTypeArgument(checker, current);
    if (target) return target;
  }
  return undefined;
}

/** A `Relation<M>` member is an array of M, a `SingleRelation<M>` one is M; a decorated member typed as the model itself is M too. */
export function relationSchema(ctx: DeriveContext, type: ts.Type): JsonSchema {
  if (!isRelationType(ctx.checker, type)) return deriveType(ctx, type);
  const target = relationTarget(ctx.checker, type);
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

/**
 * Without decorators a closed column list would publish `@Hidden` columns (a password hash), so it fails open.
 * `subject` names the type being derived when it is not the model itself (`Partial<User>`).
 */
export function opaqueModel(ctx: DeriveContext, model: ts.Type, declarationFile: ts.ClassLikeDeclaration, subject?: string): JsonSchema {
  const name = model.getSymbol()?.name ?? ctx.checker.typeToString(model);
  const base = declarationFile.name?.text ?? 'its base class';
  const described = base === name ? `model ${name}` : `model ${name} extends ${base}`;
  const lead = subject ? `${subject} has members of ${described},` : `${described}${base === name ? ' is' : ','}`;
  diagnose(ctx, 'SCH001', 'info', `${lead} read from a declaration file of ${declaringPackage(declarationFile)}, where @Hidden columns are invisible; emitted as an open object`);
  return { type: 'object' };
}

/** A mixin base that `baseClassOf` cannot walk still shows up as a member declared in a declaration file. */
function declarationFileOf(ctx: DeriveContext, model: ts.Type, members: ModelMember[]): ts.ClassLikeDeclaration | undefined {
  const direct = declarationFileClass(ctx.checker, model);
  if (direct) return direct;
  const parent = members.find((member) => member.declaration.getSourceFile().isDeclarationFile)?.declaration.parent;
  return parent && ts.isClassLike(parent) ? parent : undefined;
}

/** An ORM model derives to the columns and relations `modelMembers` lists, `@Hidden` and computed ones left out. */
export const modelType: TypeHandler = (ctx, type) => {
  if (!isModelType(ctx.checker, type)) return undefined;
  const members = modelMembers(ctx.checker, type);
  const declarationFile = declarationFileOf(ctx, type, members);
  if (declarationFile) return opaqueModel(ctx, type, declarationFile);
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const member of members) {
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
