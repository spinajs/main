import ts from 'typescript';
import type { ServiceEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { findDecorator } from '../decorators.js';
import { ctorInjectsOf, imperativeResolvesOf, lifetimeOf, propertyInjectsOf, tokenKey } from './injections.js';
import { conditionOf } from './conditions.js';

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

export const extractServices: Extractor<ServiceEntry> = (ctx, file) => {
  const out: ServiceEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const entry = fromDecorator(node as NamedClass, ctx);
      if (entry) out.push(entry);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
