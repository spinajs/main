import ts from 'typescript';
import type { Lifetime, PropertyInject, ServiceEntry } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, isArrayOfType, literalValue } from '../decorators.js';
import { injectedName, tokenConstantKey } from './token-constant.js';

type PropertyHandler = (d: { args: readonly ts.Expression[] }, prop: ts.PropertyDeclaration, ctx: ExtractorContext) => PropertyInject;
type ImperativeResolve = NonNullable<ServiceEntry['imperativeResolves']>[number];

const LIFETIMES: Record<string, Lifetime> = {
  Singleton: 'singleton',
  NewInstance: 'new-instance',
  PerChildInstance: 'per-child',
  PerInstance: 'per-instance',
  PerInstanceCheck: 'per-instance-check',
};

export function lifetimeOf(cls: ts.ClassDeclaration): Lifetime {
  for (const d of decoratorsOf(cls)) if (LIFETIMES[d.name]) return LIFETIMES[d.name];
  return 'singleton';
}

export function tokenKey(expr: ts.Expression | undefined, ctx: ExtractorContext): string {
  const name = injectedName(expr, ctx);
  if (name) return name;
  const value = literalValue(expr, ctx);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'unknown';
}

export function ctorInjectsOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): string[] {
  const inject = findDecorator(cls, 'Inject');
  if (!inject) return [];
  return inject.args.map((a) => tokenKey(a, ctx));
}

function isConcreteClass(symbol: ts.Symbol | undefined, ctx: ExtractorContext): boolean {
  if (!symbol) return false;
  const target = symbol.flags & ts.SymbolFlags.Alias ? ctx.checker.getAliasedSymbol(symbol) : symbol;
  return !!target.declarations?.some((d) => ts.isClassDeclaration(d) && !d.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword));
}

function typeNodeSymbol(node: ts.TypeNode | undefined, ctx: ExtractorContext): ts.Symbol | undefined {
  if (!node) return undefined;
  if (ts.isUnionTypeNode(node)) return typeNodeSymbol(node.types.find((t) => t.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)), ctx);
  if (!ts.isTypeReferenceNode(node)) return undefined;
  return ctx.checker.getSymbolAtLocation(ts.isIdentifier(node.typeName) ? node.typeName : node.typeName.right);
}

/** Per `@Inject` argument: the token is a non-abstract class, which the container constructs even when nothing registers it. */
export function ctorConcreteOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): boolean[] {
  const inject = findDecorator(cls, 'Inject');
  if (!inject) return [];
  return inject.args.map((a) => (ts.isIdentifier(a) || ts.isPropertyAccessExpression(a)) && isConcreteClass(ctx.checker.getSymbolAtLocation(a), ctx));
}

export function tokenOfTypeNode(node: ts.TypeNode | undefined, ctx: ExtractorContext): { token: string; array: boolean } {
  if (!node) return { token: 'unknown', array: false };
  if (ts.isArrayTypeNode(node)) return { token: tokenOfTypeNode(node.elementType, ctx).token, array: true };
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text;
    if ((name === 'Array' || name === 'Map') && node.typeArguments?.length) {
      return { token: tokenOfTypeNode(node.typeArguments[node.typeArguments.length - 1], ctx).token, array: true };
    }
    return { token: name, array: false };
  }
  if (ts.isUnionTypeNode(node)) {
    const first = node.types.find((t) => t.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword));
    return tokenOfTypeNode(first, ctx);
  }
  return { token: ctx.checker.typeToString(ctx.checker.getTypeFromTypeNode(node)), array: false };
}

function propertyName(prop: ts.PropertyDeclaration): string {
  return ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : prop.name.getText();
}

function optionsOf(arg: ts.Expression | undefined, ctx: ExtractorContext): { optional?: boolean; check?: boolean } {
  const value = literalValue(arg, ctx);
  return typeof value === 'object' && value !== null ? value : {};
}

function autoinjectSymbol(first: ts.Expression | undefined, explicit: string | undefined, prop: ts.PropertyDeclaration, ctx: ExtractorContext): ts.Symbol | undefined {
  if (!explicit) return typeNodeSymbol(prop.type, ctx);
  return first && ts.isIdentifier(first) ? ctx.checker.getSymbolAtLocation(first) : undefined;
}

/** The class the container injects when the decorator names none: what `design:type` would hold. */
function declaredTypeRef(prop: ts.PropertyDeclaration, ctx: ExtractorContext): PropertyInject['tokenRef'] {
  return ctx.runtimeRef(ctx.checker.getTypeAtLocation(prop), prop);
}

const PROPERTY_DECORATORS: Record<string, PropertyHandler> = {
  Autoinject: (d, prop, ctx) => {
    const declared = tokenOfTypeNode(prop.type, ctx);
    const first = d.args[0];
    const explicit = first && (ts.isIdentifier(first) || isArrayOfType(first)) ? injectedName(first, ctx) : undefined;
    const options = optionsOf(first && ts.isObjectLiteralExpression(first) ? first : d.args[1], ctx);
    const array = declared.array || isArrayOfType(first);
    const concrete = !array && isConcreteClass(autoinjectSymbol(first, explicit, prop, ctx), ctx);
    const tokenRef = explicit || array ? undefined : declaredTypeRef(prop, ctx);
    return {
      property: propertyName(prop),
      token: explicit ?? declared.token,
      optional: options.optional === true || !!prop.questionToken,
      array,
      ...(concrete ? { concrete: true } : {}),
      ...(options.check === true ? { check: true } : {}),
      ...(tokenRef ? { tokenRef } : {}),
    };
  },
  LazyInject: (d, prop, ctx) => {
    const declared = tokenOfTypeNode(prop.type, ctx);
    const explicit = injectedName(d.args[0], ctx);
    const tokenRef = explicit || declared.array ? undefined : declaredTypeRef(prop, ctx);
    return { property: propertyName(prop), token: explicit ?? declared.token, optional: false, array: declared.array, lazy: true, ...(tokenRef ? { tokenRef } : {}) };
  },
  Config: (_d, prop) => ({ property: propertyName(prop), token: 'Configuration', optional: false, array: false }),
  AutoinjectService: (d, prop, ctx) => {
    const declared = tokenOfTypeNode(prop.type, ctx);
    return {
      property: propertyName(prop),
      token: injectedName(d.args[1], ctx) ?? declared.token,
      optional: optionsOf(d.args[2], ctx).optional === true,
      array: declared.array,
    };
  },
  Logger: (_d, prop) => ({ property: propertyName(prop), token: 'Log', optional: false, array: false }),
  FileSystem: (_d, prop) => ({ property: propertyName(prop), token: '__file_provider__', optional: false, array: false }),
};

export function propertyInjectsOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): PropertyInject[] {
  const out: PropertyInject[] = [];
  for (const member of cls.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    for (const d of decoratorsOf(member)) {
      const handler = PROPERTY_DECORATORS[d.name];
      if (handler) out.push(handler(d, member, ctx));
    }
  }
  return out;
}

function isContainerResolve(callee: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'resolve') return false;
  const owner = callee.expression;
  if (ts.isIdentifier(owner)) return owner.text === 'DI';
  return ts.isPropertyAccessExpression(owner) && owner.name.text === 'Container';
}

export function imperativeResolvesOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): ImperativeResolve[] {
  const out: ImperativeResolve[] = [];
  for (const member of cls.members) {
    if (!ts.isMethodDeclaration(member) || !member.body) continue;
    const method = member.name.getText();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isContainerResolve(node.expression)) {
        const arg = node.arguments[0];
        const token = tokenConstantKey(arg, ctx) ?? (arg && (ts.isIdentifier(arg) || ts.isStringLiteralLike(arg)) ? arg.text : undefined);
        if (token) out.push({ token, method, awaited: ts.isAwaitExpression(node.parent), source: ctx.sourceRef(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(member.body);
  }
  return out;
}
