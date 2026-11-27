import ts from 'typescript';
import type { ValueEntry } from '@spinajs/manifest';
import type { Extractor } from '../context.js';
import { findDecorator, identifierName, literalValue } from '../decorators.js';
import type { ExtractorContext } from '../context.js';
import { classDeclarationOf, registerChainOf } from './register-chain.js';
import { tokenKey } from './injections.js';
import { conditionOf } from './conditions.js';
import { baseClassOf, extendsFrameworkClass } from '../schema/framework-members.js';

export const SCHEMA_REGISTRARS = new Set(['registerConfigurationSchema', 'registerConfigurationSchemaAtImport']);

const HTTP = '@spinajs/http';
// The member `Response` of @spinajs/http answers with (interfaces.ts); a reply class sets it as a field.
const STATUS_MEMBER = '_errorCode';

const isStatusMember = (m: ts.ClassElement): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === STATUS_MEMBER;

const builtFiles = new Map<string, ts.SourceFile | undefined>();

/** The JavaScript tsc wrote next to a declaration file, which has lost every initializer. */
function builtFileOf(declarationFile: string): ts.SourceFile | undefined {
  const path = declarationFile.replace(/\.d\.([mc]?)ts$/, '.$1js');
  if (!builtFiles.has(path)) {
    const text = path !== declarationFile ? ts.sys.readFile(path) : undefined;
    builtFiles.set(path, text !== undefined ? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS) : undefined);
  }
  return builtFiles.get(path);
}

/** A decorated class is emitted as a class expression, so both forms count. */
function classNamed(file: ts.SourceFile, name: string): ts.ClassLikeDeclaration | undefined {
  let found: ts.ClassLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isClassLike(node) && node.name?.text === name) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function assignedStatus(statement: ts.Statement): ts.Expression | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return undefined;
  const { left, right, operatorToken } = statement.expression;
  const isMember = ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && left.name.text === STATUS_MEMBER;
  return isMember && operatorToken.kind === ts.SyntaxKind.EqualsToken ? right : undefined;
}

/** The one place emitted JavaScript sets the status: a class field, or `this._errorCode = …` as a statement of the constructor. */
function builtInitializer(cls: ts.ClassLikeDeclaration): ts.Expression | undefined {
  const field = cls.members.find(isStatusMember)?.initializer;
  const assigned = (cls.members.find(ts.isConstructorDeclaration)?.body?.statements ?? []).flatMap((st) => assignedStatus(st) ?? []);
  const all = [...(field ? [field] : []), ...assigned];
  return all.length === 1 ? all[0] : undefined;
}

/** A number, or a member of the enum the declaration file types the status with. */
function builtStatus(expr: ts.Expression, declared: ts.PropertyDeclaration, checker: ts.TypeChecker): number | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return undefined;
  const enumSymbol = checker.getTypeAtLocation(declared).getSymbol();
  if (!enumSymbol || !(enumSymbol.flags & ts.SymbolFlags.Enum) || enumSymbol.name !== expr.expression.text) return undefined;
  const member = enumSymbol.exports?.get(ts.escapeLeadingUnderscores(expr.name.text))?.valueDeclaration;
  const value = member && ts.isEnumMember(member) ? checker.getConstantValue(member) : undefined;
  return typeof value === 'number' ? value : undefined;
}

function declaredStatus(cls: ts.ClassDeclaration, name: string, member: ts.PropertyDeclaration, ctx: ExtractorContext): number | undefined {
  if (member.initializer) {
    const value = literalValue(member.initializer, { checker: ctx.checker, info: () => undefined });
    return typeof value === 'number' ? value : undefined;
  }
  const file = cls.getSourceFile();
  const built = file.isDeclarationFile ? builtFileOf(file.fileName) : undefined;
  const emitted = built && classNamed(built, name);
  const expr = emitted && builtInitializer(emitted);
  return expr ? builtStatus(expr, member, ctx.checker) : undefined;
}

/**
 * The status of a reply class: the `_errorCode` of the nearest class of its chain that declares one. A class that
 * declares it where it cannot be read ends the search: a base's status would be wrong.
 */
function responseStatusOf(type: ts.Type, ctx: ExtractorContext): number | undefined {
  if (!extendsFrameworkClass(ctx.checker, type, 'Response', HTTP)) return undefined;
  for (let current: ts.Type | undefined = type, hops = 0; current && hops < 32; current = baseClassOf(ctx.checker, current), hops++) {
    const cls = current.getSymbol()?.declarations?.find(ts.isClassDeclaration);
    const member = cls?.members.find(isStatusMember);
    if (cls?.name && member) return declaredStatus(cls, cls.name.text, member, ctx);
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
