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

function fromRegister(node: ts.ExpressionStatement, ctx: ExtractorContext): ServiceEntry | undefined {
  const chain = registerChainOf(node.expression);
  const cls = chain && classDeclarationOf(chain.target, ctx);
  if (!chain || !cls?.name || !chain.calls.some((c) => c.name === 'as' || c.name === 'asSelf')) return undefined;
  const className = cls.name.text;
  const registeredAs = chain.calls.flatMap((c) => (c.name === 'as' ? [tokenKey(c.args[0], ctx)] : c.name === 'asSelf' ? [className] : []));
  const lifetime = chain.calls.some((c) => c.name === 'singleInstance') ? 'singleton' : lifetimeOf(cls);
  return entryFor(cls as NamedClass, registeredAs, lifetime, node, ctx);
}

export const extractServices: Extractor<ServiceEntry> = (ctx, file) => {
  const out: ServiceEntry[] = [];
  const visit = (node: ts.Node): void => {
    let entry: ServiceEntry | undefined;
    if (ts.isClassDeclaration(node) && node.name) entry = fromDecorator(node as NamedClass, ctx);
    else if (ts.isExpressionStatement(node)) entry = fromRegister(node, ctx);
    if (entry) out.push(entry);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
