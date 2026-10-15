import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';
import type ts from 'typescript';

import { isAccessResourceClass, primaryKeyOf } from '../access-resource.js';

/** Static members of an ORM model that start a select query builder. */
export const QUERY_ROOTS: ReadonlySet<string> = new Set(['where', 'query', 'select', 'all', 'whereExists', 'whereNotExists', 'populate']);

/** Static reads of one primary-key value (`wherePk`): single-object loads, covered by the route's check-before. */
export const PRIMARY_KEY_READS: ReadonlySet<string> = new Set(['get', 'getOrFail']);

/** Static reads of a primary-key list (`whereAnyPk`): a single-object load only with exactly one value. */
export const KEY_LIST_READS: ReadonlySet<string> = new Set(['find', 'findOrFail']);

/** Other static reads that return a promise at once, so there is no builder to scope. */
export const READ_SHORTCUTS: ReadonlySet<string> = new Set(['getOrNew', 'getOrCreate', 'first', 'last', 'newest', 'oldest', 'count', 'exists']);

/** Builder members that run the query (`@spinajs/orm` `ISelectQueryBuilder`, `ILimitBuilder`, `IBuilder`). */
export const EXECUTING_MEMBERS: ReadonlySet<string> = new Set(['first', 'firstOrFail', 'firstOrThrow', 'orThrow', 'all', 'execute', 'asRaw', 'resultExists', 'selectCount', 'then']);

export const SCOPING_MEMBERS: ReadonlySet<string> = new Set(['accessible', 'unscoped']);

export interface RequireAccessibleOptions {
  /** Class names to treat as `@AccessResource` models: decorators do not survive into `.d.ts` files. */
  readonly resources?: readonly string[];
}

export type RequireAccessibleMessageIds = 'unscopedQuery' | 'unscopedShortcut';

type Chain = { call: TSESTree.CallExpression; name: string }[];

const createRule = ESLintUtils.RuleCreator((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-authz/README.md#${name}`);

const memberName = (node: TSESTree.MemberExpression): string | undefined => (!node.computed && node.property.type === AST_NODE_TYPES.Identifier ? node.property.name : undefined);

function isRunAsCallback(fn: TSESTree.Node): boolean {
  const call = fn.parent;
  if (call?.type !== AST_NODE_TYPES.CallExpression || !call.arguments.some((a) => a === fn)) return false;
  const callee = call.callee;
  return (callee.type === AST_NODE_TYPES.Identifier && callee.name === 'runAs') || (callee.type === AST_NODE_TYPES.MemberExpression && memberName(callee) === 'runAs');
}

function insideRunAs(node: TSESTree.Node): boolean {
  for (let n: TSESTree.Node | undefined = node.parent; n; n = n.parent) {
    if ((n.type === AST_NODE_TYPES.ArrowFunctionExpression || n.type === AST_NODE_TYPES.FunctionExpression) && isRunAsCallback(n)) return true;
  }
  return false;
}

/** The calls chained on `root` (`root.a().b()`) with their member names; the chain ends at anything else. */
function chainOf(root: TSESTree.CallExpression): Chain {
  const out: Chain = [];
  let node: TSESTree.Node = root;
  for (;;) {
    const member: TSESTree.Node | undefined = node.parent;
    if (member?.type !== AST_NODE_TYPES.MemberExpression || member.object !== node) break;
    const call: TSESTree.Node | undefined = member.parent;
    const name = memberName(member);
    if (call?.type !== AST_NODE_TYPES.CallExpression || call.callee !== member || name === undefined) break;
    out.push({ call, name });
    node = call;
  }
  return out;
}

const isOneKeyList = (args: readonly TSESTree.CallExpressionArgument[]): boolean => args.length === 1 && args[0].type === AST_NODE_TYPES.ArrayExpression && args[0].elements.length === 1 && args[0].elements[0]?.type !== AST_NODE_TYPES.SpreadElement;

/** `where('<pk>', value)` with no other where in the chain: one primary-key equality, as the runtime guard reads it. */
function isPrimaryKeyWhere(root: TSESTree.CallExpression, chain: Chain, pk: string | undefined): boolean {
  if (pk === undefined || root.arguments.length !== 2) return false;
  const [column, value] = root.arguments;
  if (column.type !== AST_NODE_TYPES.Literal || column.value !== pk) return false;
  if (value.type === AST_NODE_TYPES.ArrayExpression || value.type === AST_NODE_TYPES.ObjectExpression || value.type === AST_NODE_TYPES.SpreadElement) return false;
  return !chain.some(({ name }) => /where/i.test(name));
}

export const requireAccessible = createRule<[RequireAccessibleOptions], RequireAccessibleMessageIds>({
  name: 'require-accessible',
  meta: {
    type: 'problem',
    docs: {
      description: 'Require .accessible(), .unscoped() or an enclosing runAs() on multi-row queries of @AccessResource models',
      recommended: 'error',
      requiresTypeChecking: true,
    },
    messages: {
      unscopedQuery: '{{model}} is an @AccessResource model: this query reaches {{call}} without .accessible(permission), .unscoped(reason) or an enclosing runAs(SYSTEM, reason).',
      unscopedShortcut: '{{model}}.{{call}}() reads more than one primary key of an @AccessResource model with nothing to scope: call it inside runAs(SYSTEM, reason), or use {{model}}.query() with .accessible(permission).',
    },
    schema: [
      {
        type: 'object',
        properties: { resources: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ resources: [] }],
  create(context, [options]) {
    const services = ESLintUtils.getParserServices(context);
    const checker = services.program.getTypeChecker();
    const extra = new Set(options.resources ?? []);
    const cache = new Map<ts.Symbol, boolean>();

    const classOf = (node: TSESTree.Node): ts.Symbol | undefined => {
      const tsNode = services.esTreeNodeToTSNodeMap.get(node);
      return checker.getTypeAtLocation(tsNode).getSymbol() ?? checker.getSymbolAtLocation(tsNode);
    };

    return {
      CallExpression(node): void {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.MemberExpression) return;
        const root = memberName(callee);
        if (root === undefined || PRIMARY_KEY_READS.has(root)) return;
        if (!QUERY_ROOTS.has(root) && !KEY_LIST_READS.has(root) && !READ_SHORTCUTS.has(root)) return;
        if (callee.object.type !== AST_NODE_TYPES.Identifier && callee.object.type !== AST_NODE_TYPES.MemberExpression) return;
        const model = classOf(callee.object);
        if (!isAccessResourceClass(model, checker, extra, cache) || insideRunAs(node)) return;

        const name = context.getSourceCode().getText(callee.object);
        if (!QUERY_ROOTS.has(root)) {
          if (KEY_LIST_READS.has(root) && isOneKeyList(node.arguments)) return;
          context.report({ node, messageId: 'unscopedShortcut', data: { model: name, call: root } });
          return;
        }

        const chain = chainOf(node);
        if (root === 'where' && isPrimaryKeyWhere(node, chain, primaryKeyOf(model, checker))) return;
        for (const { call, name: member } of chain) {
          if (SCOPING_MEMBERS.has(member)) return;
          if (EXECUTING_MEMBERS.has(member)) {
            context.report({ node: call, messageId: 'unscopedQuery', data: { model: name, call: `.${member}()` } });
            return;
          }
        }

        const outer = chain.length > 0 ? chain[chain.length - 1].call : node;
        if (outer.parent?.type === AST_NODE_TYPES.AwaitExpression) {
          context.report({ node: outer.parent, messageId: 'unscopedQuery', data: { model: name, call: 'await' } });
        }
      },
    };
  },
});
