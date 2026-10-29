import ts from 'typescript';
import { deriveType, diagnose, type DeriveContext, type JsonSchema, type TypeHandler } from '../derive.js';

type PropertyConstraints = (ctx: DeriveContext, symbol: ts.Symbol, declaration: ts.Node | undefined) => JsonSchema;

let constraints: PropertyConstraints = () => ({});

/** Seam for the JSDoc tag parser, so the object handler never imports it directly. */
export const propertyConstraints: PropertyConstraints = (ctx, symbol, declaration) => constraints(ctx, symbol, declaration);
export function setPropertyConstraints(fn: PropertyConstraints): void {
  constraints = fn;
}

const isCallable = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0 || checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0;

const includesUndefined = (type: ts.Type): boolean => (type.isUnion() ? type.types : [type]).some((member) => member.flags & ts.TypeFlags.Undefined);

function indexSchema(ctx: DeriveContext, type: ts.Type): JsonSchema {
  if (!(type.flags & ts.TypeFlags.Any)) return deriveType(ctx, type);
  diagnose(ctx, 'SCH001', 'info', 'index signature typed any accepts any value');
  return {};
}

/** Own data properties of the type, with the framework-excluded and callable ones removed. */
function dataProperties(ctx: DeriveContext, type: ts.Type): Array<{ property: ts.Symbol; declaration: ts.Declaration | undefined; type: ts.Type }> {
  const out: Array<{ property: ts.Symbol; declaration: ts.Declaration | undefined; type: ts.Type }> = [];
  for (const property of ctx.checker.getPropertiesOfType(type)) {
    if (property.flags & (ts.SymbolFlags.Method | ts.SymbolFlags.Signature)) continue;
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration && ctx.options.excludeMembersOf?.(declaration)) continue;
    const propertyType = ctx.checker.getTypeOfSymbolAtLocation(property, declaration ?? ctx.node);
    if (!isCallable(ctx.checker, propertyType)) out.push({ property, declaration, type: propertyType });
  }
  return out;
}

function additionalProperties(ctx: DeriveContext, type: ts.Type): JsonSchema | false {
  const index = ctx.checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (!index || (index.declaration && ctx.options.excludeMembersOf?.(index.declaration))) return false;
  return indexSchema(ctx, index.type);
}

export const objectType: TypeHandler = (ctx, type) => {
  if (!(type.flags & ts.TypeFlags.Object)) return undefined;
  if (isCallable(ctx.checker, type)) return undefined;

  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const { property, declaration, type: propertyType } of dataProperties(ctx, type)) {
    const propertyContext: DeriveContext = { ...ctx, node: declaration ?? ctx.node };
    properties[property.name] = { ...deriveType(propertyContext, propertyType), ...propertyConstraints(propertyContext, property, declaration) };
    if (!(property.flags & ts.SymbolFlags.Optional) && !includesUndefined(propertyType)) required.push(property.name);
  }

  const schema: JsonSchema = { type: 'object' };
  if (Object.keys(properties).length) schema.properties = properties;
  if (required.length) schema.required = required;
  schema.additionalProperties = additionalProperties(ctx, type);
  return schema;
};
