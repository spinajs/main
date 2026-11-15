import ts from 'typescript';
import type { SourceRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { findDecorator, identifierName } from '../decorators.js';
import { baseClassOf } from '../schema/framework-members.js';
import { classSymbolOf, modelIdOf } from './access-resources.js';

/** What an `AccessPolicy` ref of an entry point carries after its permissions. */
export interface AccessOptions {
  allowAnonymous?: true;
  resource?: { type: string } | { model: string };
}

// The argument that names the resource type, per extractor of authz-http and http-socket.
const TYPED_EXTRACTORS: Readonly<Record<string, number>> = { fromParam: 1, fromBody: 1, fromQuery: 1, fromPayload: 1, typedExtractor: 0 };

const ACCESS_DECORATORS = ['Access', 'SocketAccess'];

function extractorOf(expr: ts.Expression, ctx: ExtractorContext): AccessOptions['resource'] {
  if (!ts.isCallExpression(expr)) return undefined;
  const name = identifierName(expr.expression);
  if (name === 'fromModel') {
    const model = expr.arguments[0] && classSymbolOf(expr.arguments[0], ctx.checker);
    return model ? { model: modelIdOf(model, ctx) } : undefined;
  }
  const at = name === undefined ? undefined : TYPED_EXTRACTORS[name];
  const type = at === undefined ? undefined : expr.arguments[at];
  return type && ts.isStringLiteralLike(type) ? { type: type.text } : undefined;
}

const propertyOf = (options: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined =>
  options.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === name)?.initializer;

/** The literal `resource` extractor and `allowAnonymous` of the `@Access` / `@SocketAccess` on `node`. */
export function accessOptionsOf(node: ts.HasDecorators | undefined, ctx: ExtractorContext): AccessOptions {
  const options = node && findDecorator(node, ...ACCESS_DECORATORS)?.args[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return {};
  const resourceExpr = propertyOf(options, 'resource');
  const resource = resourceExpr && extractorOf(resourceExpr, ctx);
  const anonymous = propertyOf(options, 'allowAnonymous')?.kind === ts.SyntaxKind.TrueKeyword;
  return { ...(anonymous ? { allowAnonymous: true as const } : {}), ...(resource ? { resource } : {}) };
}

/** The class-level options as the runtime inherits them: the nearest class of the chain that declares `@Access` / `@SocketAccess`. */
export function classAccessOptionsOf(cls: ts.ClassDeclaration | undefined, ctx: ExtractorContext): AccessOptions {
  const symbol = cls?.name && ctx.checker.getSymbolAtLocation(cls.name);
  let current: ts.Type | undefined = symbol ? ctx.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  for (let hops = 0; current && hops < 32; hops++) {
    const decl = current.getSymbol()?.declarations?.find(ts.isClassDeclaration);
    if (decl && findDecorator(decl, ...ACCESS_DECORATORS)) return accessOptionsOf(decl, ctx);
    current = baseClassOf(ctx.checker, current);
  }
  return {};
}

/** The method `name` a class has, its own or inherited. */
export function methodOf(cls: ts.ClassDeclaration | undefined, name: string | undefined, ctx: ExtractorContext): ts.MethodDeclaration | undefined {
  const symbol = cls?.name && name ? ctx.checker.getSymbolAtLocation(cls.name) : undefined;
  const decl = symbol && name ? ctx.checker.getDeclaredTypeOfSymbol(symbol).getProperty(name)?.valueDeclaration : undefined;
  return decl && ts.isMethodDeclaration(decl) ? decl : undefined;
}

/** The package's class declarations by the source the extractors record for an entry. */
export function classesBySource(files: readonly ts.SourceFile[], ctx: ExtractorContext, key: (s: SourceRef) => string): Map<string, ts.ClassDeclaration> {
  const out = new Map<string, ts.ClassDeclaration>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) out.set(key(ctx.sourceRef(node)), node);
    ts.forEachChild(node, visit);
  };
  files.forEach(visit);
  return out;
}
