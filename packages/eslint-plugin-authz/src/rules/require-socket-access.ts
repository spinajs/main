import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';

import { className, decoratorName, hasAny, memberKeyName } from './decorators.js';

/** Handler decorators of `@spinajs/http-socket` that the default-deny gate guards. */
export const SOCKET_HANDLER_DECORATORS: ReadonlySet<string> = new Set(['Command', 'OnEvent']);

/** Decorators of `@spinajs/http-socket` that put a policy on a handler or its class. */
export const SOCKET_GUARD_DECORATORS: ReadonlySet<string> = new Set(['SocketAccess', 'SocketPolicy', 'SocketPolicyGroup']);

export interface RequireSocketAccessOptions {
  /** Extra decorator names that guard a socket handler, next to `SocketAccess`, `SocketPolicy` and `SocketPolicyGroup`. */
  readonly guardDecorators?: readonly string[];
}

export type RequireSocketAccessMessageIds = 'unguardedHandler';

const createRule = ESLintUtils.RuleCreator<{ recommended: boolean; requiresTypeChecking: boolean }>((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-authz/README.md#${name}`);

export const requireSocketAccess = createRule<[RequireSocketAccessOptions], RequireSocketAccessMessageIds>({
  name: 'require-socket-access',
  meta: {
    type: 'problem',
    docs: {
      description: 'Require @SocketAccess or @SocketPolicy on every socket command and event or on its controller class (compiler rule AUTHZ003)',
      recommended: true,
      requiresTypeChecking: false,
    },
    messages: {
      unguardedHandler: '{{controller}}.{{method}} is a socket {{kind}} with no @SocketAccess or @SocketPolicy on it or on its class: the server denies it (no_policy).',
    },
    schema: [
      {
        type: 'object',
        properties: { guardDecorators: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true } },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ guardDecorators: [] }],
  create(context, [options]) {
    const guards = new Set([...SOCKET_GUARD_DECORATORS, ...(options.guardDecorators ?? [])]);

    return {
      MethodDefinition(node): void {
        const handler = node.decorators.map(decoratorName).find((name) => name !== undefined && SOCKET_HANDLER_DECORATORS.has(name));
        if (handler === undefined || hasAny(node.decorators, guards)) return;
        const owner = node.parent.parent;
        if (owner.type !== AST_NODE_TYPES.ClassDeclaration && owner.type !== AST_NODE_TYPES.ClassExpression) return;
        if (hasAny(owner.decorators, guards)) return;
        context.report({ node: node.key, messageId: 'unguardedHandler', data: { controller: className(owner), method: memberKeyName(node, context.sourceCode), kind: handler === 'Command' ? 'command' : 'event' } });
      },
    };
  },
});
