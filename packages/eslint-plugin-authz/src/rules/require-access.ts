import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

/** Route verb decorators of `@spinajs/http`. */
export const ROUTE_DECORATORS: ReadonlySet<string> = new Set(['Get', 'Post', 'Put', 'Patch', 'Del', 'Head']);

/** Decorators of `@spinajs/authz-http` and `@spinajs/http` that guard a route. */
export const GUARD_DECORATORS: ReadonlySet<string> = new Set(['Access', 'Policy', 'AllowAnonymous']);

export interface RequireAccessOptions {
  /** Extra decorator names that mark a method as an http route, next to `Get`, `Post`, `Put`, `Patch`, `Del` and `Head`. */
  readonly routeDecorators?: readonly string[];
  /** Extra decorator names that guard a route, next to `Access`, `Policy` and `AllowAnonymous`. */
  readonly guardDecorators?: readonly string[];
}

export type RequireAccessMessageIds = 'unguardedRoute';

const createRule = ESLintUtils.RuleCreator<{ recommended: boolean; requiresTypeChecking: boolean }>((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-authz/README.md#${name}`);

/** `@Name`, `@Name(...)` and `@ns.Name(...)` all yield `Name`. */
function decoratorName(decorator: TSESTree.Decorator): string | undefined {
  const expression = decorator.expression.type === AST_NODE_TYPES.CallExpression ? decorator.expression.callee : decorator.expression;
  if (expression.type === AST_NODE_TYPES.Identifier) return expression.name;
  if (expression.type === AST_NODE_TYPES.MemberExpression && !expression.computed && expression.property.type === AST_NODE_TYPES.Identifier) return expression.property.name;
  return undefined;
}

const hasAny = (decorators: readonly TSESTree.Decorator[], names: ReadonlySet<string>): boolean => decorators.some((d) => names.has(decoratorName(d) ?? ''));

function className(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): string {
  if (node.id) return node.id.name;
  const parent = node.parent;
  if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) return parent.id.name;
  return '<anonymous>';
}

export const requireAccess = createRule<[RequireAccessOptions], RequireAccessMessageIds>({
  name: 'require-access',
  meta: {
    type: 'problem',
    docs: {
      description: 'Require @Access, @Policy or @AllowAnonymous on every http route method or on its controller class',
      recommended: true,
      requiresTypeChecking: false,
    },
    messages: {
      unguardedRoute: '{{controller}}.{{method}} is a route with no @Access, @Policy or @AllowAnonymous on it or on its class.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          routeDecorators: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          guardDecorators: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ routeDecorators: [], guardDecorators: [] }],
  create(context, [options]) {
    const routes = new Set([...ROUTE_DECORATORS, ...(options.routeDecorators ?? [])]);
    const guards = new Set([...GUARD_DECORATORS, ...(options.guardDecorators ?? [])]);

    return {
      MethodDefinition(node): void {
        if (!hasAny(node.decorators, routes) || hasAny(node.decorators, guards)) return;
        const owner = node.parent.parent;
        if (owner.type !== AST_NODE_TYPES.ClassDeclaration && owner.type !== AST_NODE_TYPES.ClassExpression) return;
        if (hasAny(owner.decorators, guards)) return;

        const key = node.key;
        const method = !node.computed && key.type === AST_NODE_TYPES.Identifier ? key.name : key.type === AST_NODE_TYPES.Literal ? String(key.value) : context.sourceCode.getText(key);
        context.report({ node: node.key, messageId: 'unguardedRoute', data: { controller: className(owner), method } });
      },
    };
  },
});
