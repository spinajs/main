import ts from 'typescript';
import type { ServiceEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator } from '../decorators.js';
import { ctorInjectsOf, imperativeResolvesOf, lifetimeOf, propertyInjectsOf, tokenKey } from './injections.js';
import { conditionOf } from './conditions.js';
import { classDeclarationOf, registerChainOf } from './register-chain.js';

type NamedClass = ts.ClassDeclaration & { name: ts.Identifier };

function entryFor(cls: NamedClass, registeredAs: string[], lifetime: ServiceEntry['lifetime'], site: ts.Node, ctx: ExtractorContext): ServiceEntry {
  const condition = conditionOf(site, ctx);
  const imperativeResolves = imperativeResolvesOf(cls, ctx);
  return {
    id: `${ctx.packageName}:${cls.name.text}`,
    className: cls.name.text,
    registeredAs,
    lifetime,
    async: ctx.isSubclassOf(cls, 'AsyncService'),
    bootstrapper: ctx.isSubclassOf(cls, 'Bootstrapper'),
    ctorInjects: ctorInjectsOf(cls, ctx),
    propertyInjects: propertyInjectsOf(cls, ctx),
    ...(imperativeResolves.length ? { imperativeResolves } : {}),
    ...(condition ? { condition } : {}),
    source: ctx.sourceRef(site),
  };
}

function fromDecorator(node: NamedClass, ctx: ExtractorContext): ServiceEntry | undefined {
  const injectable = findDecorator(node, 'Injectable');
  if (!injectable) return undefined;
  const as = injectable.args[0] ? tokenKey(injectable.args[0], ctx) : undefined;
  return entryFor(node, as ? [as, node.name.text] : [node.name.text], lifetimeOf(node), node, ctx);
}

function registrationsIn(expr: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(expr)) return registrationsIn(expr.expression);
  if (ts.isConditionalExpression(expr)) return [...registrationsIn(expr.whenTrue), ...registrationsIn(expr.whenFalse)];
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return registrationsIn(expr.right);
  return [expr];
}

function fromRegister(expr: ts.Expression, ctx: ExtractorContext): ServiceEntry | undefined {
  const chain = registerChainOf(expr);
  const cls = chain && classDeclarationOf(chain.target, ctx);
  if (!chain || !cls?.name || !chain.calls.some((c) => c.name === 'as' || c.name === 'asSelf')) return undefined;
  const className = cls.name.text;
  const registeredAs = chain.calls.flatMap((c) => (c.name === 'as' ? [tokenKey(c.args[0], ctx)] : c.name === 'asSelf' ? [className] : []));
  const lifetime = chain.calls.some((c) => c.name === 'singleInstance') ? 'singleton' : lifetimeOf(cls);
  return entryFor(cls as NamedClass, registeredAs, lifetime, expr, ctx);
}

function mergeById(entries: ServiceEntry[]): ServiceEntry[] {
  const byId = new Map<string, ServiceEntry>();
  for (const entry of entries) {
    const key = `${entry.id}|${entry.lifetime}|${JSON.stringify(entry.condition ?? null)}`;
    const existing = byId.get(key);
    if (existing) existing.registeredAs = [...new Set([...existing.registeredAs, ...entry.registeredAs])];
    else byId.set(key, entry);
  }
  return [...byId.values()];
}

export const extractServices: Extractor<ServiceEntry> = (ctx, file) => {
  const out: ServiceEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const entry = fromDecorator(node as NamedClass, ctx);
      if (entry) out.push(entry);
    } else if (ts.isExpressionStatement(node)) {
      for (const expr of registrationsIn(node.expression)) {
        const entry = fromRegister(expr, ctx);
        if (entry) out.push(entry);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return mergeById(out);
};
