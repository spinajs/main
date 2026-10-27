import ts from 'typescript';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigModuleEntry, ConfigUsageEntry } from '@spinajs/manifest';
import type { Extractor, ExtractorContext } from '../context.js';
import { decoratorsOf, literalValue } from '../decorators.js';
import { registerChainOf } from './register-chain.js';
import { tokenKey } from './injections.js';
import { SCHEMA_REGISTRARS } from './values.js';

const CONFIG_TYPES = new Set(['Configuration', 'FrameworkConfiguration']);

export const extractConfigModules: Extractor<ConfigModuleEntry> = (ctx, file) => {
  const out: ConfigModuleEntry[] = [];
  const record = (schemaExpr: ts.Expression | undefined, node: ts.Node): void => {
    const schema = literalValue(schemaExpr, ctx) as { $id?: string; $configurationModule?: string } | undefined;
    if (!schema?.$id || !schema.$configurationModule) {
      ctx.warn('CFG010', 'configuration schema is not a literal with $id and $configurationModule', node);
      return;
    }
    ctx.schemas[schema.$id] = schema;
    const defaults = `src/config/${schema.$configurationModule}.ts`;
    out.push({
      module: schema.$configurationModule,
      schemaId: schema.$id,
      ...(existsSync(join(ctx.packageRoot, defaults)) ? { defaultsFile: defaults } : {}),
      source: ctx.sourceRef(node),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      const e = node.expression;
      if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && SCHEMA_REGISTRARS.has(e.expression.text)) record(e.arguments[0], node);
      const chain = registerChainOf(e);
      if (chain?.calls.some((c) => c.name === 'asValue' && tokenKey(c.args[0], ctx) === '__configurationSchema__')) record(chain.target, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};

function isConfigurationReceiver(expr: ts.Expression, ctx: ExtractorContext): boolean {
  const receiver = ctx.checker.getTypeAtLocation(expr);
  if (CONFIG_TYPES.has(receiver.getSymbol()?.name ?? '')) return true;
  if (!(receiver.flags & ts.TypeFlags.Object) || !((receiver as ts.ObjectType).objectFlags & ts.ObjectFlags.ClassOrInterface)) return false;
  return ctx.checker.getBaseTypes(receiver as ts.InterfaceType).some((b) => CONFIG_TYPES.has(b.getSymbol()?.name ?? ''));
}

export const extractConfigUsages: Extractor<ConfigUsageEntry> = (ctx, file) => {
  const out: ConfigUsageEntry[] = [];
  const add = (expr: ts.Expression | undefined, node: ts.Node): void => {
    if (expr && ts.isStringLiteralLike(expr)) out.push({ path: expr.text, source: ctx.sourceRef(node) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyDeclaration(node)) {
      for (const d of decoratorsOf(node)) {
        if (d.name === 'Config' || d.name === 'AutoinjectService') add(d.args[0], node);
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'get') {
      if (isConfigurationReceiver(node.expression.expression, ctx)) add(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
