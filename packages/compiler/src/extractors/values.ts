import ts from 'typescript';
import type { ValueEntry } from '@spinajs/manifest';
import type { Extractor } from '../context.js';
import { findDecorator, identifierName, literalValue } from '../decorators.js';
import type { ExtractorContext } from '../context.js';
import { classDeclarationOf, registerChainOf } from './register-chain.js';
import { tokenKey } from './injections.js';
import { conditionOf } from './conditions.js';

export const SCHEMA_REGISTRARS = new Set(['registerConfigurationSchema', 'registerConfigurationSchemaAtImport']);

/** Status codes of the `@spinajs/http` response classes (`_errorCode` in response-methods/*.ts). */
const RESPONSE_STATUS: Record<string, number> = {
  Ok: 200, Json: 200, Xml: 200, Created: 201, NoContent: 204, BadRequestResponse: 400, ValidationError: 400, Unauthorized: 401,
  ForbiddenResponse: 403, NotFound: 404, NotAllowed: 405, NotAcceptable: 406, Conflict: 409, EntityTooLarge: 413,
  UnsupportedMediaType: 415, TooManyRequests: 429, ServerError: 500,
};

/** Status of the nearest known response class along the base chain. */
function responseStatusOf(type: ts.Type, ctx: ExtractorContext, seen = new Set<ts.Type>()): number | undefined {
  if (seen.has(type) || !(type.flags & ts.TypeFlags.Object)) return undefined;
  seen.add(type);
  const known = RESPONSE_STATUS[type.getSymbol()?.name ?? ''];
  if (known !== undefined) return known;
  for (const base of ctx.checker.getBaseTypes(type as ts.InterfaceType)) {
    const status = responseStatusOf(base, ctx, seen);
    if (status !== undefined) return status;
  }
  return undefined;
}

function handledExceptions(node: ts.ClassDeclaration & { name: ts.Identifier }, ctx: ExtractorContext, out: ValueEntry[]): void {
  const decorator = findDecorator(node, 'HandleException');
  const arg = decorator?.args[0];
  if (!arg) return;
  const status = responseStatusOf(ctx.checker.getTypeAtLocation(node), ctx);
  if (status === undefined) ctx.info('CMP004', `cannot determine the HTTP status of ${node.name.text}, which handles exceptions`, node);
  const exceptions = ts.isArrayLiteralExpression(arg) ? arg.elements : [arg];
  for (const e of exceptions) {
    const mapKey = identifierName(e);
    if (!mapKey) continue;
    const condition = conditionOf(node, ctx);
    out.push({
      token: '__http_error_map__',
      kind: 'map',
      mapKey,
      value: { response: node.name.text, ...(status !== undefined ? { status } : {}) },
      ...(condition ? { condition } : {}),
      source: ctx.sourceRef(node),
    });
  }
}

export const extractValues: Extractor<ValueEntry> = (ctx, file) => {
  const out: ValueEntry[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) handledExceptions(node as ts.ClassDeclaration & { name: ts.Identifier }, ctx, out);
    if (ts.isExpressionStatement(node)) {
      const base = (): Pick<ValueEntry, 'condition' | 'source'> => {
        const condition = conditionOf(node, ctx);
        return { ...(condition ? { condition } : {}), source: ctx.sourceRef(node) };
      };
      const e = node.expression;
      const chain = registerChainOf(e);
      if (chain) {
        for (const call of chain.calls) {
          if (call.name === 'asValue' || (call.name === 'asToken' && !classDeclarationOf(chain.target, ctx))) out.push({ token: tokenKey(call.args[0], ctx), kind: 'value', ...base() });
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
