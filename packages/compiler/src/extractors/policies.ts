import ts from 'typescript';
import type { PolicyRef } from '@spinajs/manifest';
import type { ExtractorContext } from '../context.js';
import { decoratorsOf, identifierName, literalValue } from '../decorators.js';

const refOf = (expr: ts.Expression | undefined, ctx: ExtractorContext): string => {
  const value = identifierName(expr) ?? literalValue(expr, ctx);
  return typeof value === 'string' ? value : 'unknown';
};

interface AccessInfo {
  access?: string[];
  allowAnonymous?: boolean;
  also: string[];
  fieldsFilter: boolean;
}

function accessOptions(arg: ts.Expression | undefined, ctx: ExtractorContext): { also: string[]; fieldsFilter: boolean } {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return { also: [], fieldsFilter: false };
  const alsoProp = arg.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText() === 'also');
  const also = alsoProp && ts.isArrayLiteralExpression(alsoProp.initializer) ? alsoProp.initializer.elements.map((e) => refOf(e, ctx)) : [];
  const fieldsFilter = (literalValue(arg, ctx) as { fields?: string } | undefined)?.fields === 'filter';
  return { also, fieldsFilter };
}

export function accessOf(node: ts.HasDecorators, ctx: ExtractorContext): AccessInfo {
  const info: AccessInfo = { also: [], fieldsFilter: false };
  for (const d of decoratorsOf(node)) {
    if (d.name === 'Access') {
      const first = literalValue(d.args[0], ctx);
      info.access = Array.isArray(first) ? first.map(String) : [String(first)];
      Object.assign(info, accessOptions(d.args[1], ctx));
    }
    if (d.name === 'AllowAnonymous') info.allowAnonymous = true;
  }
  return info;
}

export function policyGroupsOf(node: ts.HasDecorators, ctx: ExtractorContext, scope: 'route' | 'class'): PolicyRef[][] {
  const groups: PolicyRef[][] = [];
  for (const d of decoratorsOf(node)) {
    if (d.name !== 'Policy' && d.name !== 'SocketPolicy') continue;
    const first = d.args[0];
    const members = first && ts.isArrayLiteralExpression(first) ? [...first.elements] : first ? [first] : [];
    const options = d.args.slice(1).map((a) => literalValue(a, ctx));
    if (members.length) groups.push(members.map((m) => ({ type: refOf(m, ctx), options })));
  }
  const { access, also } = accessOf(node, ctx);
  if (access) groups.push([{ type: 'AccessPolicy', options: [scope] }, ...also.map((type) => ({ type, options: [] as unknown[] }))]);
  return groups;
}

export function middlewaresOf(node: ts.HasDecorators, ctx: ExtractorContext): { type: string; options?: unknown[] }[] {
  const out = decoratorsOf(node)
    .filter((d) => d.name === 'Middleware')
    .map((d) => ({ type: refOf(d.args[0], ctx), options: d.args.slice(1).map((a) => literalValue(a, ctx)) }));
  if (accessOf(node, ctx).fieldsFilter) out.push({ type: 'AuthzFieldsMiddleware', options: [] });
  return out;
}
