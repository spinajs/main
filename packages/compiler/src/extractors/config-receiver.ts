import ts from 'typescript';
import type { ExtractorContext } from '../context.js';

export const CONFIG_TYPES = new Set(['Configuration', 'FrameworkConfiguration']);

function matches(type: ts.Type, ctx: ExtractorContext, seen: Set<ts.Type>): boolean {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.isUnion()) return type.types.some((t) => matches(t, ctx, seen));
  if (CONFIG_TYPES.has(type.getSymbol()?.name ?? '')) return true;
  if (!((type as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)) return false;
  return ctx.checker.getBaseTypes(type as ts.InterfaceType).some((b) => matches(b, ctx, seen));
}

/** True for Configuration, FrameworkConfiguration, their subclasses and nullable unions of them. */
export function isConfigurationReceiver(type: ts.Type, ctx: ExtractorContext): boolean {
  return matches(ctx.checker.getNonNullableType(type), ctx, new Set());
}
