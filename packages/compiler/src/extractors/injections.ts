import ts from 'typescript';
import type { Lifetime, ServiceEntry } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, findDecorator, identifierName, isArrayOfType, literalValue } from '../decorators.js';

type PropertyInject = ServiceEntry['propertyInjects'][number];
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
  const name = identifierName(expr);
  if (name) return name;
  const value = literalValue(expr, ctx);
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'unknown';
}

export function ctorInjectsOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): string[] {
  const inject = findDecorator(cls, 'Inject');
  if (!inject) return [];
  return inject.args.map((a) => tokenKey(a, ctx));
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

function optionsOf(arg: ts.Expression | undefined, ctx: ExtractorContext): { optional?: boolean } {
  const value = literalValue(arg, ctx);
  return typeof value === 'object' && value !== null ? value : {};
}

const PROPERTY_DECORATORS: Record<string, PropertyHandler> = {
  Autoinject: (d, prop, ctx) => {
    const declared = tokenOfTypeNode(prop.type, ctx);
    const first = d.args[0];
    const explicit = first && (ts.isIdentifier(first) || isArrayOfType(first)) ? identifierName(first) : undefined;
    const options = optionsOf(first && ts.isObjectLiteralExpression(first) ? first : d.args[1], ctx);
    return {
      property: propertyName(prop),
      token: explicit ?? declared.token,
      optional: options.optional === true || !!prop.questionToken,
      array: declared.array || isArrayOfType(first),
    };
  },
  LazyInject: (d, prop, ctx) => {
    const declared = tokenOfTypeNode(prop.type, ctx);
    return { property: propertyName(prop), token: identifierName(d.args[0]) ?? declared.token, optional: false, array: declared.array, lazy: true };
  },
  Config: (_d, prop) => ({ property: propertyName(prop), token: 'Configuration', optional: false, array: false }),
  AutoinjectService: (d, prop, ctx) => {
    const declared = tokenOfTypeNode(prop.type, ctx);
    return {
      property: propertyName(prop),
      token: identifierName(d.args[1]) ?? declared.token,
      optional: optionsOf(d.args[2], ctx).optional === true,
      array: declared.array,
    };
  },
  Logger: (_d, prop) => ({ property: propertyName(prop), token: 'Log', optional: false, array: false }),
  FileSystem: (_d, prop) => ({ property: propertyName(prop), token: '__file_provider__', optional: false, array: false }),
};

export function propertyInjectsOf(cls: ts.ClassDeclaration, ctx: ExtractorContext): ServiceEntry['propertyInjects'] {
  const out: ServiceEntry['propertyInjects'] = [];
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
        const token = arg && (ts.isIdentifier(arg) || ts.isStringLiteralLike(arg)) ? arg.text : undefined;
        if (token) out.push({ token, method, awaited: ts.isAwaitExpression(node.parent), source: ctx.sourceRef(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(member.body);
  }
  return out;
}
