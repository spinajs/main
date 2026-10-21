import { AST_NODE_TYPES, ESLintUtils } from '@typescript-eslint/utils';
import type { TSESTree } from '@typescript-eslint/utils';

import { ROUTE_DECORATORS } from './require-access.js';

/** Route-arg decorators of `@spinajs/http` that hand an action the raw express request or response. */
export const RAW_REQUEST_DECORATORS: ReadonlySet<string> = new Set(['Req', 'Res']);

/** Helpers that read a field of the raw body past route-argument validation. */
export const RAW_BODY_READERS: ReadonlySet<string> = new Set(['bodyField']);

export interface NoRawRequestOptions {
  /** Extra parameter decorator names to refuse, next to `Req` and `Res`. */
  readonly decorators?: readonly string[];
  /** Extra function names whose calls are refused inside a controller, next to `bodyField`. */
  readonly functions?: readonly string[];
}

export type NoRawRequestMessageIds = 'rawRequestArg' | 'rawBodyRead';

const createRule = ESLintUtils.RuleCreator<{ recommended: boolean; requiresTypeChecking: boolean }>((name) => `https://github.com/spinajs/main/blob/master/packages/eslint-plugin-authz/README.md#${name}`);

type ClassNode = TSESTree.ClassDeclaration | TSESTree.ClassExpression;

function decoratorName(decorator: TSESTree.Decorator): string | undefined {
  const expression = decorator.expression.type === AST_NODE_TYPES.CallExpression ? decorator.expression.callee : decorator.expression;
  if (expression.type === AST_NODE_TYPES.Identifier) return expression.name;
  if (expression.type === AST_NODE_TYPES.MemberExpression && !expression.computed && expression.property.type === AST_NODE_TYPES.Identifier) return expression.property.name;
  return undefined;
}

function calleeName(callee: TSESTree.Expression): string | undefined {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name;
  if (callee.type === AST_NODE_TYPES.MemberExpression && !callee.computed && callee.property.type === AST_NODE_TYPES.Identifier) return callee.property.name;
  return undefined;
}

function className(node: ClassNode): string {
  if (node.id) return node.id.name;
  const parent = node.parent;
  if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) return parent.id.name;
  return '<anonymous>';
}

function methodName(node: TSESTree.MethodDefinition, source: { getText(node: TSESTree.Node): string }): string {
  const key = node.key;
  if (!node.computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
  return key.type === AST_NODE_TYPES.Literal ? String(key.value) : source.getText(key);
}

/** A controller extends a class named `…Controller` (`BaseController` and its subclasses) or declares a route method. */
function isController(node: ClassNode): boolean {
  const base = node.superClass;
  const baseName = base?.type === AST_NODE_TYPES.Identifier ? base.name : base?.type === AST_NODE_TYPES.MemberExpression && !base.computed && base.property.type === AST_NODE_TYPES.Identifier ? base.property.name : undefined;
  if (baseName?.endsWith('Controller')) return true;
  return node.body.body.some((m) => m.type === AST_NODE_TYPES.MethodDefinition && m.decorators.some((d) => ROUTE_DECORATORS.has(decoratorName(d) ?? '')));
}

function enclosingClass(node: TSESTree.Node): ClassNode | undefined {
  for (let n: TSESTree.Node | undefined = node.parent; n; n = n.parent) {
    if (n.type === AST_NODE_TYPES.ClassDeclaration || n.type === AST_NODE_TYPES.ClassExpression) return n;
  }
  return undefined;
}

export const noRawRequest = createRule<[NoRawRequestOptions], NoRawRequestMessageIds>({
  name: 'no-raw-request',
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid @Req()/@Res() parameters and raw body reads (bodyField) in http controllers, so every input passes route-argument validation',
      recommended: false,
      requiresTypeChecking: false,
    },
    messages: {
      rawRequestArg: '{{controller}}.{{method}} takes the raw request through @{{decorator}}(): declare its inputs with @Body, @Query, @Param, @Header, @Cookie or a typed arg decorator.',
      rawBodyRead: '{{controller}} reads the raw body with {{name}}(): take a validated @Body() DTO instead.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          decorators: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
          functions: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ decorators: [], functions: [] }],
  create(context, [options]) {
    const decorators = new Set([...RAW_REQUEST_DECORATORS, ...(options.decorators ?? [])]);
    const functions = new Set([...RAW_BODY_READERS, ...(options.functions ?? [])]);
    const controllers = new WeakMap<ClassNode, boolean>();
    const controller = (node: ClassNode): boolean => {
      let known = controllers.get(node);
      if (known === undefined) controllers.set(node, (known = isController(node)));
      return known;
    };

    return {
      MethodDefinition(node): void {
        const owner = node.parent.parent;
        if ((owner.type !== AST_NODE_TYPES.ClassDeclaration && owner.type !== AST_NODE_TYPES.ClassExpression) || !controller(owner)) return;
        for (const param of node.value.params) {
          for (const decorator of param.decorators ?? []) {
            const name = decoratorName(decorator);
            if (name === undefined || !decorators.has(name)) continue;
            context.report({ node: decorator, messageId: 'rawRequestArg', data: { controller: className(owner), method: methodName(node, context.sourceCode), decorator: name } });
          }
        }
      },
      CallExpression(node): void {
        const name = calleeName(node.callee);
        if (name === undefined || !functions.has(name)) return;
        const owner = enclosingClass(node);
        if (owner && controller(owner)) context.report({ node, messageId: 'rawBodyRead', data: { controller: className(owner), name } });
      },
    };
  },
});
