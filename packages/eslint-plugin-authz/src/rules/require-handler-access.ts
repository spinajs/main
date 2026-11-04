import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

import { className, decoratorName, hasAny } from './decorators.js';

export type RequireHandlerAccessMessageIds = 'undeclaredJob' | 'undeclaredSystemJob';

const createRule = ESLintUtils.RuleCreator<{ recommended: boolean; requiresTypeChecking: boolean }>((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-authz/README.md#${name}`);

const SYSTEM_TASK: ReadonlySet<string> = new Set(['SystemTask']);

const propertyNamed = (options: TSESTree.ObjectExpression, name: string): TSESTree.Property | undefined =>
  options.properties.find((p): p is TSESTree.Property => p.type === AST_NODE_TYPES.Property && !p.computed && ((p.key.type === AST_NODE_TYPES.Identifier && p.key.name === name) || (p.key.type === AST_NODE_TYPES.Literal && p.key.value === name)));

function extendsQueueJob(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): boolean {
  const base = node.superClass;
  if (base?.type === AST_NODE_TYPES.Identifier) return base.name === 'QueueJob';
  return base?.type === AST_NODE_TYPES.MemberExpression && !base.computed && base.property.type === AST_NODE_TYPES.Identifier && base.property.name === 'QueueJob';
}

/** The literal options object of `@Job({...})`; `undefined` for `@Job()` or a non-literal argument. */
function jobOptions(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): TSESTree.ObjectExpression | undefined {
  const job = node.decorators.find((d) => decoratorName(d) === 'Job');
  const arg = job?.expression.type === AST_NODE_TYPES.CallExpression ? job.expression.arguments[0] : undefined;
  return arg?.type === AST_NODE_TYPES.ObjectExpression ? arg : undefined;
}

export const requireHandlerAccess = createRule<[], RequireHandlerAccessMessageIds>({
  name: 'require-handler-access',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Require @Job({ access }) or @SystemTask(reason) on every queue job (compiler rule AUTHZ004)',
      recommended: true,
      requiresTypeChecking: false,
    },
    messages: {
      undeclaredJob: '{{job}} is a queue job with no @Job({ access }) and no @SystemTask(reason).',
      undeclaredSystemJob: "{{job}} runs as SYSTEM with no access: runAs: 'system' needs @SystemTask(reason).",
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const check = (node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): void => {
      const isJob = node.decorators.some((d) => decoratorName(d) === 'Job') || extendsQueueJob(node);
      if (!isJob || node.abstract || hasAny(node.decorators, SYSTEM_TASK)) return;
      const options = jobOptions(node);
      if (options && propertyNamed(options, 'access')) return;
      const runAs = options && propertyNamed(options, 'runAs')?.value;
      const system = runAs?.type === AST_NODE_TYPES.Literal && runAs.value === 'system';
      context.report({ node: node.id ?? node, messageId: system ? 'undeclaredSystemJob' : 'undeclaredJob', data: { job: className(node) } });
    };
    return { ClassDeclaration: check, ClassExpression: check };
  },
});
