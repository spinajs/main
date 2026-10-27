import ts from 'typescript';
import type { Diagnostic, SourceRef } from '@spinajs/manifest';
import { arrayType, tupleType } from './handlers/array.js';
import { enumType } from './handlers/enum.js';
import { objectType } from './handlers/object.js';
import { primitive } from './handlers/primitive.js';
import { hoistedId } from './naming.js';
import { wellKnown } from './wellknown.js';
import { intersectionType, unionType } from './handlers/union.js';

export type JsonSchema = { [keyword: string]: unknown };

export interface DeriveOptions {
  idPrefix: string;
  maxDepth: number;
  sourceRef?: (node: ts.Node) => SourceRef;
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
  depth: number;
}

export type TypeHandler = (ctx: DeriveContext, type: ts.Type) => JsonSchema | undefined;

let handlerList: TypeHandler[] | undefined;

/** Built on first use: the handler modules import this one, so a top-level list would hit a TDZ when one of them loads first. Order matters (enum before primitive, well-known before object). */
export function handlers(): TypeHandler[] {
  handlerList ??= [enumType, primitive, wellKnown, arrayType, tupleType, unionType, intersectionType, objectType];
  return handlerList;
}

export function diagnose(ctx: DeriveContext, code: 'SCH001' | 'SCH002', severity: Diagnostic['severity'], message: string): void {
  ctx.diagnostics.push({ code, severity, message, source: ctx.options.sourceRef?.(ctx.node) });
}

export function deriveSchema(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, options: DeriveOptions, registry: Map<string, JsonSchema>): DeriveResult {
  const ctx: DeriveContext = { checker, node, options, registry, diagnostics: [], seen: new Map(), depth: 0 };
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
  const id = hoistedId(inner, type);
  if (!id) return deriveBody(inner, type);
  if (!inner.registry.has(id)) {
    inner.registry.set(id, { $id: id });
    inner.registry.set(id, { $id: id, ...deriveBody(inner, type) });
  }
  return { $ref: id };
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
