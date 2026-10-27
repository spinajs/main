import ts from 'typescript';
import type { ValueEntry } from '@spinajs/manifest';
import type { Extractor } from '../context.js';
import { literalValue } from '../decorators.js';
import { registerChainOf } from './register-chain.js';
import { tokenKey } from './injections.js';
import { conditionOf } from './conditions.js';

export const SCHEMA_REGISTRARS = new Set(['registerConfigurationSchema', 'registerConfigurationSchemaAtImport']);

export const extractValues: Extractor<ValueEntry> = (ctx, file) => {
  const out: ValueEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node)) {
      const base = (): Pick<ValueEntry, 'condition' | 'source'> => {
        const condition = conditionOf(node, ctx);
        return { ...(condition ? { condition } : {}), source: ctx.sourceRef(node) };
      };
      const e = node.expression;
      const chain = registerChainOf(e);
      if (chain) {
        for (const call of chain.calls) {
          if (call.name === 'asValue') out.push({ token: tokenKey(call.args[0], ctx), kind: 'value', ...base() });
          if (call.name === 'asMapValue') {
            const mapKey = literalValue(call.args[1], ctx);
            out.push({ token: tokenKey(call.args[0], ctx), kind: 'map', mapKey: typeof mapKey === 'string' ? mapKey : '', ...base() });
          }
        }
      } else if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && SCHEMA_REGISTRARS.has(e.expression.text)) {
        out.push({ token: '__configurationSchema__', kind: 'value', ...base() });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
};
