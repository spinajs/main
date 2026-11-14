import { AST_NODE_TYPES } from '@typescript-eslint/utils';
import type { TSESLint, TSESTree } from '@typescript-eslint/utils';

/** `@Name`, `@Name(...)` and `@ns.Name(...)` all yield `Name`. */
export function decoratorName(decorator: TSESTree.Decorator): string | undefined {
  const expression = decorator.expression.type === AST_NODE_TYPES.CallExpression ? decorator.expression.callee : decorator.expression;
  if (expression.type === AST_NODE_TYPES.Identifier) return expression.name;
  if (expression.type === AST_NODE_TYPES.MemberExpression && !expression.computed && expression.property.type === AST_NODE_TYPES.Identifier) return expression.property.name;
  return undefined;
}

export const hasAny = (decorators: readonly TSESTree.Decorator[], names: ReadonlySet<string>): boolean => decorators.some((d) => names.has(decoratorName(d) ?? ''));

export function className(node: TSESTree.ClassDeclaration | TSESTree.ClassExpression): string {
  if (node.id) return node.id.name;
  const parent = node.parent;
  if (parent.type === AST_NODE_TYPES.VariableDeclarator && parent.id.type === AST_NODE_TYPES.Identifier) return parent.id.name;
  return '<anonymous>';
}

export function memberKeyName(node: TSESTree.MethodDefinition, sourceCode: Readonly<TSESLint.SourceCode>): string {
  const key = node.key;
  if (!node.computed && key.type === AST_NODE_TYPES.Identifier) return key.name;
  return key.type === AST_NODE_TYPES.Literal ? String(key.value) : sourceCode.getText(key);
}
