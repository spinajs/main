import ts from 'typescript';
import type { ClassPropertiesEntry, Lifetime, PropertyInject, ServiceEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, isArrayOfType, literalValue } from '../decorators.js';
import { isListType } from '../runtime-ref.js';
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

const declaresList = (prop: ts.PropertyDeclaration, ctx: ExtractorContext): boolean => isListType(ctx.checker.getTypeAtLocation(prop), ctx.checker);

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
    const array = declaresList(prop, ctx) || isArrayOfType(first);
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
    const array = declaresList(prop, ctx);
    const tokenRef = explicit || array ? undefined : declaredTypeRef(prop, ctx);
    return { property: propertyName(prop), token: explicit ?? declared.token, optional: false, array, lazy: true, ...(tokenRef ? { tokenRef } : {}) };
  },
  Config: (_d, prop) => ({ property: propertyName(prop), token: 'Configuration', optional: false, array: false }),
  AutoinjectService: (d, prop, ctx) => {
    const declared = tokenOfTypeNode(prop.type, ctx);
    const explicit = injectedName(d.args[1], ctx);
    const array = declaresList(prop, ctx);
    const tokenRef = explicit || array ? undefined : declaredTypeRef(prop, ctx);
    return {
      property: propertyName(prop),
      token: explicit ?? declared.token,
      optional: optionsOf(d.args[2], ctx).optional === true,
      array,
      ...(tokenRef ? { tokenRef } : {}),
    };
  },
  Logger: (_d, prop) => ({ property: propertyName(prop), token: 'Log', optional: false, array: false }),
  FileSystem: (_d, prop) => ({ property: propertyName(prop), token: '__file_provider__', optional: false, array: false }),
};

export function propertyInjectsOf(cls: ts.ClassDeclaration, ctx: ExtractorContext, only?: ReadonlySet<string>): PropertyInject[] {
  const out: PropertyInject[] = [];
  for (const member of cls.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    for (const d of decoratorsOf(member)) {
      const handler = PROPERTY_DECORATORS[d.name];
      if (handler && (!only || only.has(d.name))) out.push(handler(d, member, ctx));
    }
  }
  return out;
}

// The decorators that read `design:type`; `@Logger`, `@Config` and `@FileSystem` inject by their own arguments.
const TYPE_READING_DECORATORS = new Set(['Autoinject', 'LazyInject', 'AutoinjectService']);
// Model decorators that need the class the property declares. They inject nothing, so they stay out of `propertyInjects`.
const MODEL_TYPE_DECORATORS = new Set(['HasMany', 'HasManyToMany', 'Virtual', 'JunctionTable']);

function modelTypesOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): PropertyInject[] {
  return cls.members.filter(ts.isPropertyDeclaration).flatMap((member) => {
    if (!decoratorsOf(member).some((d) => MODEL_TYPE_DECORATORS.has(d.name))) return [];
    const tokenRef = declaredTypeRef(member, ctx);
    return [{ property: propertyName(member), token: tokenOfTypeNode(member.type, ctx).token, optional: false, array: false, ...(tokenRef ? { tokenRef } : {}) }];
  });
}

/**
 * The compiler knows decorators by name, so one of the app's own may wrap `@Autoinject(X)`. Only the list shape is
 * recorded: a row without `tokenRef` imports nothing, whichever decorator it turns out to be.
 */
function otherDecoratedOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): PropertyInject[] {
  return cls.members.filter(ts.isPropertyDeclaration).flatMap((member) => {
    const decorators = decoratorsOf(member);
    if (decorators.length === 0 || decorators.some((d) => PROPERTY_DECORATORS[d.name] || MODEL_TYPE_DECORATORS.has(d.name))) return [];
    return [{ property: propertyName(member), token: tokenOfTypeNode(member.type, ctx).token, optional: !!member.questionToken, array: declaresList(member, ctx) }];
  });
}

/**
 * A class of any kind can declare these: a policy, a model, a schedule, an abstract base. Nothing reads the table in a
 * build with decorator metadata, and the runtime imports every `tokenRef` at boot, so such a build has none.
 */
export const extractClassProperties: Extractor<ClassPropertiesEntry> = (ctx, file) => {
  if (ctx.program.getCompilerOptions().emitDecoratorMetadata) return [];
  const out: ClassPropertiesEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const properties = [...propertyInjectsOf(node, ctx, TYPE_READING_DECORATORS), ...modelTypesOf(node, ctx), ...otherDecoratedOf(node, ctx)];
      if (properties.length > 0) out.push({ id: `${ctx.packageName}:${node.name.text}`, className: node.name.text, properties, source: ctx.sourceRef(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};

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
