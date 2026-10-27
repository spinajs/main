import ts from 'typescript';
import type { Diagnostic, SourceRef } from '@spinajs/manifest';
import { arrayType, tupleType } from './handlers/array.js';
import { enumType } from './handlers/enum.js';
import { modelDataType, modelType } from './handlers/model.js';
import { objectType, setPropertyConstraints } from './handlers/object.js';
import { primitive } from './handlers/primitive.js';
import { jsdocConstraints } from './jsdoc.js';
import { explicitSchema } from './explicit.js';
import { aliasName, hoistedId } from './naming.js';
import { wellKnown } from './wellknown.js';
import { intersectionType, unionType } from './handlers/union.js';

export type JsonSchema = { [keyword: string]: unknown };

export interface DeriveOptions {
  idPrefix: string;
  maxDepth: number;
  sourceRef?: (node: ts.Node) => SourceRef;
  /** Names the declaring type when the node lies outside the analyzed package, so diagnostics can say where the type came from. */
  foreignOwner?: (node: ts.Node) => string | undefined;
  /** Members declared here are left out of object schemas (framework base classes). */
  excludeMembersOf?: (declaration: ts.Declaration) => boolean;
  /** Which type produced each registry entry, kept across calls to detect id collisions. */
  owners?: Map<string, ts.Type>;
}

export interface DeriveResult {
  schema: JsonSchema;
  id?: string;
  diagnostics: Diagnostic[];
}

export interface DeriveContext {
  checker: ts.TypeChecker;
  node: ts.Node;
  options: DeriveOptions;
  registry: Map<string, JsonSchema>;
  diagnostics: Diagnostic[];
  seen: Map<ts.Type, string>;
  owners: Map<string, ts.Type>;
  /** Union and intersection aliases being derived on the current path, and the ones found to refer to themselves. */
  aliasStack: Set<ts.Type>;
  recursiveAliases: Set<ts.Type>;
  depth: number;
}

export type TypeHandler = (ctx: DeriveContext, type: ts.Type) => JsonSchema | undefined;

let handlerList: TypeHandler[] | undefined;

/** Built on first use: the handler modules import this one, so a top-level list would hit a TDZ when one of them loads first. Order matters (enum before primitive, model data before intersection, well-known and model before object). */
export function handlers(): TypeHandler[] {
  if (!handlerList) setPropertyConstraints(jsdocConstraints);
  handlerList ??= [enumType, primitive, wellKnown, modelDataType, arrayType, tupleType, unionType, intersectionType, modelType, objectType];
  return handlerList;
}

export function diagnose(ctx: DeriveContext, code: 'SCH001' | 'SCH002' | 'SCH005', severity: Diagnostic['severity'], message: string): void {
  const owner = ctx.options.foreignOwner?.(ctx.node);
  ctx.diagnostics.push({ code, severity, message: owner ? `${message} (declared in ${owner})` : message, source: ctx.options.sourceRef?.(ctx.node) });
}

export function deriveSchema(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, options: DeriveOptions, registry: Map<string, JsonSchema>): DeriveResult {
  const ctx: DeriveContext = { checker, node, options, registry, diagnostics: [], seen: new Map(), owners: options.owners ?? new Map(), aliasStack: new Set(), recursiveAliases: new Set(), depth: 0 };
  const schema = deriveType(ctx, type);
  const id = typeof schema.$ref === 'string' && registry.has(schema.$ref) ? schema.$ref : undefined;
  return { schema: (id && registry.get(id)) || schema, id, diagnostics: ctx.diagnostics };
}

export function deriveType(ctx: DeriveContext, type: ts.Type): JsonSchema {
  if (ctx.depth >= ctx.options.maxDepth) {
    diagnose(ctx, 'SCH002', 'warning', `type ${ctx.checker.typeToString(type)} nests deeper than ${ctx.options.maxDepth}, emitted as {}`);
    return {};
  }
  const inner: DeriveContext = { ...ctx, depth: ctx.depth + 1 };
  const hoisted = hoistedId(inner, type);
  if (!hoisted) return deriveAlias(inner, type);

  const explicit = explicitSchema(inner, type);
  const id = explicit?.id ?? hoisted;
  if (inner.registry.has(id)) reportCollision(inner, id, type);
  else {
    inner.owners.set(id, type);
    if (typeof explicit?.schema.$ref === 'string') {
      inner.registry.set(id, { $id: id, $ref: explicit.schema.$ref });
      return { $ref: id };
    }
    inner.registry.set(id, { $id: id });
    const derived = deriveBody(inner, type);
    if (!explicit) inner.registry.set(id, { $id: id, ...derived });
    else inner.registry.set(id, { ...explicit.schema, $id: id, 'x-derived': derived });
  }
  return { $ref: id };
}

/** Inlined unless it refers to itself; a recursive alias is hoisted so the recursion ends in a `$ref`, not at the depth limit. */
function deriveAlias(ctx: DeriveContext, type: ts.Type): JsonSchema {
  const name = aliasName(ctx.checker, type);
  if (!name) return deriveBody(ctx, type);
  const id = ctx.options.idPrefix + name;
  if (ctx.owners.get(id) === type && ctx.registry.has(id)) return { $ref: id };
  if (ctx.aliasStack.has(type)) {
    ctx.recursiveAliases.add(type);
    return { $ref: id };
  }
  ctx.aliasStack.add(type);
  const body = deriveBody(ctx, type);
  ctx.aliasStack.delete(type);
  if (!ctx.recursiveAliases.has(type)) return body;
  const owner = ctx.owners.get(id);
  if (owner && owner !== type) {
    diagnose(ctx, 'SCH005', 'warning', `schema id ${id} is produced by two different types: ${describeType(ctx, owner)} and ${describeType(ctx, type)}`);
    return { $ref: id };
  }
  ctx.owners.set(id, type);
  ctx.registry.set(id, { $id: id, ...body });
  return { $ref: id };
}

function bodyOf(schema: JsonSchema | undefined): string {
  if (!schema) return '';
  const rest = Object.entries(schema).filter(([key]) => key !== '$id' && key !== 'x-derived');
  return JSON.stringify(schema['x-derived'] ?? Object.fromEntries(rest));
}

function describeType(ctx: DeriveContext, type: ts.Type): string {
  const declaration = type.getSymbol()?.declarations?.[0];
  const source = declaration && ctx.options.sourceRef?.(declaration);
  const name = ctx.checker.typeToString(type);
  return source ? `${name} (${source.file}:${source.line})` : name;
}

function reportCollision(ctx: DeriveContext, id: string, type: ts.Type): void {
  const owner = ctx.owners.get(id);
  if (!owner || owner === type) return;
  const probe: DeriveContext = { ...ctx, registry: new Map(ctx.registry), diagnostics: [], owners: new Map(ctx.owners) };
  if (JSON.stringify(deriveBody(probe, type)) === bodyOf(ctx.registry.get(id))) return;
  diagnose(ctx, 'SCH005', 'warning', `schema id ${id} is produced by two different types: ${describeType(ctx, owner)} and ${describeType(ctx, type)}`);
}

function unsupported(ctx: DeriveContext, type: ts.Type): JsonSchema {
  const text = ctx.checker.typeToString(type);
  if (type.flags & ts.TypeFlags.Unknown) {
    diagnose(ctx, 'SCH001', 'info', `unknown type at ${text} accepts any value`);
    return {};
  }
  if (type.flags & ts.TypeFlags.NonPrimitive) {
    diagnose(ctx, 'SCH001', 'info', 'object type has no properties to validate');
    return { type: 'object' };
  }
  diagnose(ctx, 'SCH001', 'warning', `unsupported type ${text}, emitted as {}`);
  return {};
}

function deriveBody(ctx: DeriveContext, type: ts.Type): JsonSchema {
  for (const handler of handlers()) {
    const schema = handler(ctx, type);
    if (schema) return schema;
  }
  return unsupported(ctx, type);
}
