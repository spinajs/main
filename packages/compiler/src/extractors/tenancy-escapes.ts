import ts from 'typescript';
import type { TenancyEscape } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { QueryTracer } from '../flow/query-values.js';
import { isDeclaredIn } from '../schema/framework-members.js';
import { isFunctionOf } from './decorator-origin.js';
import { literalText } from './string-arg.js';
import { TENANCY_ORM } from './tenant-models.js';

export const TENANCY = '@spinajs/tenancy';

/** The member access of a call to the `acrossTenants` that `@spinajs/tenancy-orm` declares; a method of the same name on another class is none. */
function acrossTenantsAccess(call: ts.CallExpression, checker: ts.TypeChecker): ts.PropertyAccessExpression | undefined {
  const access = call.expression;
  if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'acrossTenants') return undefined;
  const symbol = checker.getSymbolAtLocation(access.name) ?? checker.getTypeAtLocation(access.expression).getProperty('acrossTenants');
  return symbol?.declarations?.some((d) => isDeclaredIn(d, TENANCY_ORM)) ? access : undefined;
}

function escapeOf(call: ts.CallExpression, tracer: () => QueryTracer, ctx: ExtractorContext): TenancyEscape | undefined {
  const reason = literalText(call.arguments[0]);
  const stated = reason === undefined ? {} : { reason };
  const access = acrossTenantsAccess(call, ctx.checker);
  if (access) {
    const model = tracer().traced(access.expression)?.value.model;
    return { kind: 'acrossTenants', ...stated, ...(model ? { model } : {}), source: ctx.sourceRef(access.name) };
  }
  return isFunctionOf(call.expression, 'runAcrossTenants', TENANCY, ctx.checker) ? { kind: 'runAcrossTenants', ...stated, source: ctx.sourceRef(call) } : undefined;
}

function escapesInFile(file: ts.SourceFile, ctx: ExtractorContext): TenancyEscape[] {
  const out: TenancyEscape[] = [];
  let traced: QueryTracer | undefined;
  // Tracing a file costs a type lookup per variable, so it waits for the first builder escape.
  const tracer = (): QueryTracer => (traced ??= new QueryTracer(ctx.checker).run(file));
  const visit = (node: ts.Node): void => {
    const escape = ts.isCallExpression(node) ? escapeOf(node, tracer, ctx) : undefined;
    if (escape) out.push(escape);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** Every `.acrossTenants(reason)` on a query builder and every `runAcrossTenants(reason, fn)` call of the package, in source order. */
export function escapesIn(files: readonly ts.SourceFile[], ctx: ExtractorContext): TenancyEscape[] {
  return files.flatMap((file) => escapesInFile(file, ctx));
}
