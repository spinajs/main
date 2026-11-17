import ts from 'typescript';
import { isDeclaredIn } from '../schema/framework-members.js';
import type { EdgeVia } from './call-graph.js';
import { modelShape } from './query-values.js';

/** What a builder does when it runs; `other` is a static model member that neither returns a builder nor rows (an insert, a count). */
export type BuilderKind = 'select' | 'update' | 'delete' | 'other';
export type EffectScope = 'accessible' | 'unscoped' | 'system' | 'none';
export interface PathStep {
  readonly name: string;
  readonly node: ts.Node;
  readonly via: EdgeVia;
}
export interface AuthzEffect {
  readonly kind: 'read-many' | 'read-one' | 'update' | 'delete' | 'other';
  readonly model: string;
  readonly scoped: EffectScope;
  readonly reason?: string;
  readonly site: ts.Node;
  readonly path: readonly PathStep[];
}
export interface SystemRun {
  readonly site: ts.CallExpression;
  readonly reason?: string;
  readonly path: readonly PathStep[];
}
/** A kind and model a builder may be: one of a union type, of a choice or of a call with several targets. */
export interface BuilderVariant {
  readonly kind: BuilderKind;
  readonly model: string;
}
export interface ReturnedBuilder {
  readonly kind: BuilderKind;
  readonly model: string;
  readonly scoped: { readonly accessible: boolean; readonly unscoped: boolean };
  readonly param?: number;
  /** Every kind and model the builder may be, when it may be more than one. */
  readonly variants?: readonly BuilderVariant[];
}

export interface FunctionSummary {
  readonly effects: readonly AuthzEffect[];
  readonly systemRuns: readonly SystemRun[];
  /** A builder the function hands back unexecuted (only a function that is not async can); `param` when it came in as that parameter. */
  readonly returns?: ReturnedBuilder;
  /** Parameter index to the kind of builder the function executes from it without scoping it. */
  readonly executes: ReadonlyMap<number, BuilderKind>;
}

const ORM = '@spinajs/orm';
const AUTHZ = '@spinajs/authz';
/** `@spinajs/authz` re-exports `SYSTEM` from here. */
const PRINCIPAL = '@spinajs/principal';

const BUILDERS: ReadonlyMap<string, BuilderKind> = new Map<string, BuilderKind>([
  ['SelectQueryBuilder', 'select'],
  ['ISelectQueryBuilder', 'select'],
  ['UpdateQueryBuilder', 'update'],
  ['IUpdateQueryBuilder', 'update'],
  ['DeleteQueryBuilder', 'delete'],
  ['IDeleteQueryBuilder', 'delete'],
]);

/** Builder members that run the query: the set `eslint-plugin-authz` uses (`rules/require-accessible.ts`). */
export const EXECUTING_MEMBERS: ReadonlySet<string> = new Set(['first', 'firstOrFail', 'firstOrThrow', 'orThrow', 'all', 'execute', 'asRaw', 'resultExists', 'selectCount', 'then']);

const isReference = (t: ts.Type): t is ts.TypeReference => 'objectFlags' in t && typeof t.objectFlags === 'number' && (t.objectFlags & ts.ObjectFlags.Reference) !== 0;

/** `type` without `null`/`undefined`, a type parameter as its constraint, and unions and intersections as their members. */
function partsOf(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): ts.Type[] {
  if (seen.has(type)) return [];
  seen.add(type);
  if (type.isTypeParameter()) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined ? [] : partsOf(checker, constraint, seen);
  }
  // A type parameter comes back as `T & {}`, so its members go through this function again.
  const value = checker.getNonNullableType(type);
  if (value.isUnionOrIntersection()) return value.types.flatMap((t) => partsOf(checker, t, seen));
  return value === type ? [value] : partsOf(checker, value, seen);
}

/**
 * Every ORM builder `type` is or may be (`Builder & T['_queryScopes']`, `Builder | undefined`, `B extends Builder`,
 * the builder members of a union), with the model of its type argument.
 */
export function buildersOf(checker: ts.TypeChecker, type: ts.Type): Array<{ kind: BuilderKind; model: string | undefined }> {
  const out: Array<{ kind: BuilderKind; model: string | undefined }> = [];
  for (const part of partsOf(checker, type)) {
    const symbol = part.getSymbol() ?? part.aliasSymbol;
    const kind = symbol !== undefined && isDeclaredIn(symbol.declarations?.[0], ORM) ? BUILDERS.get(symbol.name) : undefined;
    if (kind === undefined) continue;
    const [argument] = isReference(part) ? checker.getTypeArguments(part) : [];
    const model = argument === undefined ? undefined : modelShape(checker, argument)?.model;
    if (!out.some((b) => b.kind === kind && b.model === model)) out.push({ kind, model });
  }
  return out;
}

/** The first builder `type` may be; `buildersOf` gives them all. */
export function builderOf(checker: ts.TypeChecker, type: ts.Type): { kind: BuilderKind; model: string | undefined } | undefined {
  return buildersOf(checker, type).at(0);
}

/**
 * What a static model member starts, read from what it returns: a builder gives its kind, a promise of rows is a
 * select, anything else (an insert, a count, an existence test) is `other`.
 */
export function staticKind(checker: ts.TypeChecker, call: ts.CallExpression): BuilderKind {
  const type = checker.getTypeAtLocation(call);
  const builder = builderOf(checker, type);
  if (builder !== undefined) return builder.kind;
  const awaited = checker.getAwaitedType(type);
  return awaited !== undefined && modelShape(checker, awaited) !== undefined ? 'select' : 'other';
}

/** `x.runAs(SYSTEM, reason, fn)`, `runAs` being declared by `@spinajs/authz` and `SYSTEM` by `@spinajs/principal`. */
export function isSystemRunAs(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ts.isIdentifier(call.expression) ? call.expression.text : undefined;
  if (callee !== 'runAs' || call.arguments.length < 3 || !isDeclaredIn(checker.getResolvedSignature(call)?.getDeclaration(), AUTHZ)) return false;
  const first = call.arguments[0];
  const symbol = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(first) ? first.name : first);
  const target = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  return target?.name === 'SYSTEM' && isDeclaredIn(target.declarations?.[0], PRINCIPAL);
}

/** A string literal or a template without substitutions, when it is not blank. */
export function literalReason(expr: ts.Expression | undefined): string | undefined {
  return expr !== undefined && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) && expr.text.trim() !== '' ? expr.text : undefined;
}

const place = (node: ts.Node): string => `${node.getSourceFile().fileName}:${node.pos}`;

/** What makes two effects the same one: its query site, kind, model and scope. The path is not part of it. */
export const effectKey = (e: AuthzEffect): string => `${place(e.site)}:${e.kind}:${e.model}:${e.scoped}:${e.reason ?? ''}`;
export const runKey = (r: SystemRun): string => `${place(r.site)}:${r.reason ?? ''}`;
