import ts from 'typescript';
import type { DeriveContext } from './derive.js';

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
const nonNullish = (types: readonly ts.Type[]): ts.Type[] => types.filter((member) => !(member.flags & NULLISH));
const sameTypes = (a: readonly ts.Type[], b: readonly ts.Type[]): boolean => a.length === b.length && a.every((member, i) => member === b[i]);

/** Aliases the declaration's type annotation names, so `x: F | null` finds F before F itself was ever derived. */
function annotatedAliases(checker: ts.TypeChecker, node: ts.Node): ts.Type[] {
  const annotation = (node as { type?: ts.Node }).type;
  if (!annotation || !ts.isTypeNode(annotation)) return [];
  const out: ts.Type[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) out.push(checker.getTypeFromTypeNode(child));
    ts.forEachChild(child, visit);
  };
  visit(annotation);
  return out;
}

/**
 * `F | undefined` and `F | null` are fresh unions of F's members without F's alias symbol, so a self-reference written
 * as `arg?: F` or `arg: F | null` is not F by identity. Finds F again by its members (union members are interned and
 * sorted, so identical member lists mean the same alias).
 */
export function nullableAliasOf(ctx: DeriveContext, type: ts.Type): ts.UnionType | undefined {
  if (!type.isUnion() || type.aliasSymbol) return undefined;
  const members = nonNullish(type.types);
  if (members.length < 2 || members.length === type.types.length) return undefined;
  const candidates = [...ctx.aliasStack, ...ctx.owners.values(), ...annotatedAliases(ctx.checker, ctx.node)];
  return candidates.find((candidate): candidate is ts.UnionType => !!candidate.aliasSymbol && candidate.isUnion() && sameTypes(nonNullish(candidate.types), members));
}

/** Whether `type` adds a `null` that the alias it was matched to does not already allow. */
export const addsNull = (type: ts.UnionType, alias: ts.UnionType): boolean =>
  type.types.some((member) => member.flags & ts.TypeFlags.Null) && !alias.types.some((member) => member.flags & ts.TypeFlags.Null);
