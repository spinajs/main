import ts from 'typescript';
import { declarationMarker, symbolMarker, typeMarker } from '../markers.js';
import { isAsyncIterable, isAwaitable } from '../type-shapes.js';
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
export interface ReturnedBuilder {
  readonly kind: BuilderKind;
  readonly model: string;
  readonly scoped: { readonly accessible: boolean; readonly unscoped: boolean };
  readonly param?: number;
}

export interface FunctionSummary {
  readonly effects: readonly AuthzEffect[];
  readonly systemRuns: readonly SystemRun[];
  /** A builder the function hands back unexecuted (only a function that is not async can); `param` when it came in as that parameter. */
  readonly returns?: ReturnedBuilder;
  /** Parameter index to the kind of builder the function executes from it without scoping it. */
  readonly executes: ReadonlyMap<number, BuilderKind>;
}

type QueryKind = Exclude<BuilderKind, 'other'>;
/** The `@spinajs query` values the pass follows. */
const FOLLOWED: ReadonlySet<string> = new Set(['select', 'update', 'delete']);
const isFollowed = (value: string): value is QueryKind => FOLLOWED.has(value);

const isReference = (t: ts.Type): t is ts.TypeReference => 'objectFlags' in t && typeof t.objectFlags === 'number' && (t.objectFlags & ts.ObjectFlags.Reference) !== 0;
const isUntyped = (t: ts.Type): boolean => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;

/** `type` without `null`/`undefined`, an open type as its constraint, and unions and intersections as their members. */
function partsOf(checker: ts.TypeChecker, type: ts.Type, seen = new Set<ts.Type>()): ts.Type[] {
  if (seen.has(type)) return [];
  seen.add(type);
  // Open: a type parameter, and a conditional or indexed type over one (`StrictAliasNarrowed<B, …>` inside a generic function).
  if ((type.flags & ts.TypeFlags.Instantiable) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined || constraint === type ? [] : partsOf(checker, constraint, seen);
  }
  // A type parameter comes back as `T & {}`, so its members go through this function again.
  const value = checker.getNonNullableType(type);
  if (value.isUnionOrIntersection()) return value.types.flatMap((t) => partsOf(checker, t, seen));
  return value === type ? [value] : partsOf(checker, value, seen);
}

/** The kind `part` is marked with. The ORM authorizes no insert, so an insert builder is not followed. */
function queryKind(checker: ts.TypeChecker, part: ts.Type): QueryKind | undefined {
  const marker = typeMarker(checker, part, 'query');
  if (marker === undefined || marker === 'insert') return undefined;
  // Reading an unknown value as `other` would hide every query of that builder.
  if (!isFollowed(marker)) throw new Error(`@spinajs query: unknown value '${marker}' on ${checker.typeToString(part)} (expected select, update, delete or insert)`);
  return marker;
}

/**
 * The builder `type` is or may be (`Builder & T['_queryScopes']`, `Builder | undefined`, `B extends Builder`, a union with a
 * builder member, a subclass of one), with the model of its type argument.
 */
export function builderOf(checker: ts.TypeChecker, type: ts.Type): { kind: BuilderKind; model: string | undefined } | undefined {
  for (const part of partsOf(checker, type)) {
    const kind = queryKind(checker, part);
    if (kind === undefined) continue;
    const [argument] = isReference(part) ? checker.getTypeArguments(part) : [];
    return { kind, model: argument === undefined ? undefined : modelShape(checker, argument)?.model };
  }
  return undefined;
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

/**
 * A call on a traced builder ran the query when what it gives back is no builder and can be awaited or iterated
 * asynchronously. An untyped result cannot show that it did not, so it counts.
 */
export function runsQuery(checker: ts.TypeChecker, call: ts.CallExpression): boolean {
  const result = checker.getTypeAtLocation(call);
  return isUntyped(result) || (builderOf(checker, result) === undefined && (isAwaitable(checker, result) || isAsyncIterable(checker, result)));
}

/** `x.runAs(SYSTEM, reason, fn)`: the member called is marked `@spinajs run-as` and its principal `@spinajs system-principal`. */
export function isSystemRunAs(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (call.arguments.length < 3 || declarationMarker(checker.getResolvedSignature(call)?.getDeclaration(), 'run-as') === undefined) return false;
  const first = call.arguments[0];
  return symbolMarker(checker, checker.getSymbolAtLocation(ts.isPropertyAccessExpression(first) ? first.name : first), 'system-principal') !== undefined;
}

/** A string literal or a template without substitutions, when it is not blank. */
export function literalReason(expr: ts.Expression | undefined): string | undefined {
  return expr !== undefined && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) && expr.text.trim() !== '' ? expr.text : undefined;
}

const place = (node: ts.Node): string => `${node.getSourceFile().fileName}:${node.pos}`;

/** What makes two effects the same one: its query site, kind and scope. The path is not part of it. */
export const effectKey = (e: AuthzEffect): string => `${place(e.site)}:${e.kind}:${e.scoped}:${e.reason ?? ''}`;
export const runKey = (r: SystemRun): string => `${place(r.site)}:${r.reason ?? ''}`;
