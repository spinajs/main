import { ESLintUtils } from '@typescript-eslint/utils';

export interface RequireAccessOptions {
  /** Extra decorator names that mark a method as an http route, next to `Get`, `Post`, `Put`, `Patch`, `Del` and `Head`. */
  readonly routeDecorators?: readonly string[];
  /** Extra decorator names that guard a route, next to `Access`, `Policy` and `AllowAnonymous`. */
  readonly guardDecorators?: readonly string[];
}

export type RequireAccessMessageIds = 'unguardedRoute';

const createRule = ESLintUtils.RuleCreator<{ recommended: boolean; requiresTypeChecking: boolean }>((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-authz/README.md#${name}`);

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
  create() {
    throw new Error('not implemented: require-access');
  },
});
