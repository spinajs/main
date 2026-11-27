import ts from 'typescript';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConfigModuleEntry, ConfigUsageEntry } from '@spinajs/manifest';
import type { Extractor } from '../context.js';
import { decoratorsOf } from '../decorators.js';
import { resolveLiteral, withoutUnresolved } from '../schema/explicit.js';
import { registerChainOf } from './register-chain.js';
import { tokenKey } from './injections.js';
import { SCHEMA_REGISTRARS } from './values.js';
import { isConfigurationReceiver } from './config-receiver.js';
import { owningPackage } from '../owning-package.js';

export const extractConfigModules: Extractor<ConfigModuleEntry> = (ctx, file) => {
  const out: ConfigModuleEntry[] = [];
  // A variable of a dependency's `.d.ts` has no initializer to read; when that package ships a fragment, its own build
  // recorded the schema. A member of a declared type is a value of this package and still warns.
  const declaredByDependency = (expr: ts.Expression): boolean => {
    let symbol = ctx.checker.getSymbolAtLocation(ts.isPropertyAccessExpression(expr) ? expr.name : expr);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = ctx.checker.getAliasedSymbol(symbol);
    return (
      symbol?.declarations?.some((d) => {
        const file = d.getSourceFile();
        const owner = ts.isVariableDeclaration(d) && file.isDeclarationFile ? owningPackage(file.fileName) : undefined;
        return owner?.fragment !== undefined && resolve(owner.root) !== ctx.packageRoot;
      }) === true
    );
  };
  const record = (schemaExpr: ts.Expression | undefined, node: ts.Node): void => {
    const { value, unresolved } = schemaExpr ? resolveLiteral(ctx.checker, schemaExpr) : { value: undefined, unresolved: [] };
    const schema = value as { $id?: string; $configurationModule?: string } | undefined;
    if (!schema?.$id || !schema.$configurationModule) {
      if (schemaExpr && declaredByDependency(schemaExpr)) return;
      ctx.warn('CFG010', 'configuration schema is not a literal with $id and $configurationModule', node);
      return;
    }
    for (const part of unresolved) ctx.info('CMP001', `non-literal configuration schema member: ${part.getText()}`, part);
    ctx.schemas[schema.$id] = unresolved.length > 0 ? { ...(withoutUnresolved(schema) as object), 'x-explicit': 'partial' } : schema;
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
      if (isConfigurationReceiver(ctx.checker.getTypeAtLocation(node.expression.expression), ctx)) add(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
