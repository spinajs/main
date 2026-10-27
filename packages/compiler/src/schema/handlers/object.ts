import ts from 'typescript';
import { modelOrigin, type ModelMember, type ModelOrigin } from '../../model-members.js';
import { deriveType, diagnose, type DeriveContext, type JsonSchema, type TypeHandler } from '../derive.js';
import { opaqueModel, relationSchema } from './model.js';

type PropertyConstraints = (ctx: DeriveContext, symbol: ts.Symbol, declaration: ts.Node | undefined) => JsonSchema;

let constraints: PropertyConstraints = () => ({});

/** Seam for the JSDoc tag parser, so the object handler never imports it directly. */
export const propertyConstraints: PropertyConstraints = (ctx, symbol, declaration) => constraints(ctx, symbol, declaration);
export function setPropertyConstraints(fn: PropertyConstraints): void {
  constraints = fn;
}

export const isCallable = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;

export const includesUndefined = (type: ts.Type): boolean => (type.isUnion() ? type.types : [type]).some((member) => member.flags & ts.TypeFlags.Undefined);

function indexSchema(ctx: DeriveContext, type: ts.Type): JsonSchema {
  if (!(type.flags & ts.TypeFlags.Any)) return deriveType(ctx, type);
  diagnose(ctx, 'SCH001', 'info', 'index signature typed any accepts any value');
  return {};
}

const NON_PUBLIC = ts.ModifierFlags.Private | ts.ModifierFlags.Protected;

export function isPublicMember(declaration: ts.Declaration): boolean {
  const name = ts.getNameOfDeclaration(declaration);
  return !(ts.getCombinedModifierFlags(declaration) & NON_PUBLIC) && !(name && ts.isPrivateIdentifier(name));
}

interface DataProperty {
  property: ts.Symbol;
  declaration: ts.Declaration | undefined;
  type: ts.Type;
  member?: ModelMember;
}

type OpaqueOrigin = Extract<ModelOrigin, { kind: 'opaque' }>;

/** Own public data properties of the type, with the framework-excluded and callable ones removed; members declared by a model follow `modelOrigin`. */
function dataProperties(ctx: DeriveContext, type: ts.Type): { properties: DataProperty[]; opaque?: OpaqueOrigin } {
  const properties: DataProperty[] = [];
  for (const property of ctx.checker.getPropertiesOfType(type)) {
    if (property.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Signature)) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration && (!isPublicMember(declaration) || ctx.options.excludeMembersOf?.(declaration))) continue;
    const origin: ModelOrigin = declaration ? modelOrigin(ctx.checker, declaration) : { kind: 'none' };
    if (origin.kind === 'opaque') return { properties: [], opaque: origin };
    if (origin.kind === 'omitted') continue;
    const propertyType = ctx.checker.getTypeOfSymbolAtLocation(property, declaration ?? ctx.node);
    if (!isCallable(ctx.checker, propertyType)) properties.push({ property, declaration, type: propertyType, member: origin.kind === 'member' ? origin.member : undefined });
  }
  return { properties };
}

function additionalProperties(ctx: DeriveContext, type: ts.Type): JsonSchema | false {
  const index = ctx.checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (!index || (index.declaration && ctx.options.excludeMembersOf?.(index.declaration))) return false;
  return indexSchema(ctx, index.type);
}

export const objectType: TypeHandler = (ctx, type) => {
  if (!(type.flags & ts.TypeFlags.Object)) return undefined;
  if (isCallable(ctx.checker, type)) return undefined;

  const { properties: members, opaque } = dataProperties(ctx, type);
  if (opaque) return opaqueModel(ctx, opaque.model, opaque.declarationFile, ctx.checker.typeToString(type));
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const { property, declaration, type: propertyType, member } of members) {
    const propertyContext: DeriveContext = { ...ctx, node: declaration ?? ctx.node };
    // As on the model itself, a relation is an optional $ref or array of the target model.
    if (member?.kind === 'relation') {
      properties[property.name] = relationSchema(propertyContext, ctx.checker.getNonNullableType(propertyType));
      continue;
    }
    properties[property.name] = { ...deriveType(propertyContext, propertyType), ...propertyConstraints(propertyContext, property, declaration) };
    if (!(property.flags & ts.SymbolFlags.Optional) && !includesUndefined(propertyType)) required.push(property.name);
  }

  const schema: JsonSchema = { type: 'object' };
  if (Object.keys(properties).length) schema.properties = properties;
  if (required.length) schema.required = required;
  schema.additionalProperties = additionalProperties(ctx, type);
  return schema;
};
