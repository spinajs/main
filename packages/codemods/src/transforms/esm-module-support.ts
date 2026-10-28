import { ConditionalExpression, Expression, Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { Transform } from '../index.js';

/** true when the probe is truthy under CommonJS, false when it is truthy under ESM, undefined when it is no probe */
function probePolarity(expr: Expression): boolean | undefined {
  if (!Node.isBinaryExpression(expr)) {
    return undefined;
  }

  const left = expr.getLeft();
  const right = expr.getRight();
  if (!Node.isTypeOfExpression(left) || left.getExpression().getText() !== 'module') {
    return undefined;
  }
  if (!Node.isStringLiteral(right) || right.getLiteralValue() !== 'undefined') {
    return undefined;
  }

  switch (expr.getOperatorToken().getText()) {
    case '!==':
    case '!=':
      return true;
    case '===':
    case '==':
      return false;
    default:
      return undefined;
  }
}

function collectProbeVariables(file: SourceFile): Map<string, boolean> {
  const probes = new Map<string, boolean>();
  for (const decl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    const polarity = init ? probePolarity(init) : undefined;
    if (polarity !== undefined) {
      probes.set(decl.getName(), polarity);
    }
  }
  return probes;
}

function conditionPolarity(cond: Expression, variables: Map<string, boolean>): boolean | undefined {
  if (Node.isIdentifier(cond)) {
    return variables.get(cond.getText());
  }
  return probePolarity(cond);
}

function findProbeConditional(file: SourceFile, variables: Map<string, boolean>): [ConditionalExpression, boolean] | undefined {
  for (const node of file.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    const polarity = conditionPolarity(node.getCondition(), variables);
    if (polarity !== undefined) {
      return [node, polarity];
    }
  }
  return undefined;
}

function replaceWithEsmBranch(node: ConditionalExpression, cjsWhenTrue: boolean): void {
  const branch = cjsWhenTrue ? node.getWhenFalse() : node.getWhenTrue();

  if (!Node.isStringLiteral(branch)) {
    node.replaceWithText(branch.getText());
    return;
  }

  const value = branch.getLiteralValue();
  const flat = value
    .split('/')
    .filter((segment) => segment !== 'mjs')
    .join('/');

  if (flat !== '') {
    const quote = branch.getText()[0];
    node.replaceWithText(`${quote}${flat}${quote}`);
    return;
  }

  const parent = node.getParent();
  if (Node.isCallExpression(parent) && parent.getArguments().some((a) => a === node)) {
    parent.removeArgument(node);
  } else {
    node.replaceWithText("''");
  }
}

function removeUnusedProbes(file: SourceFile, names: Iterable<string>): void {
  for (const name of names) {
    const uses = file.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => id.getText() === name);
    if (uses.length !== 1) {
      continue;
    }
    const decl = uses[0].getParent();
    if (!Node.isVariableDeclaration(decl)) {
      continue;
    }
    const list = decl.getParent();
    if (Node.isVariableDeclarationList(list) && list.getDeclarations().length === 1) {
      list.getParent().remove();
    } else {
      decl.remove();
    }
  }
}

function removeEsmSupportCalls(file: SourceFile): boolean {
  const calls = file
    .getDescendantsOfKind(SyntaxKind.ExpressionStatement)
    .filter((stmt) => {
      const expr = stmt.getExpression();
      if (!Node.isCallExpression(expr)) {
        return false;
      }
      const callee = expr.getExpression();
      return Node.isPropertyAccessExpression(callee) ? callee.getName() === 'setESMModuleSupport' : callee.getText() === 'setESMModuleSupport';
    });

  for (const stmt of calls) {
    stmt.remove();
  }
  return calls.length > 0;
}

export const esmModuleSupport: Transform = {
  name: 'esm-module-support',
  description: 'Removes DI.setESMModuleSupport() and the typeof module cjs/mjs switch',
  apply(_project, file) {
    let changed = removeEsmSupportCalls(file);

    const variables = collectProbeVariables(file);
    for (;;) {
      const found = findProbeConditional(file, variables);
      if (!found) {
        break;
      }
      replaceWithEsmBranch(found[0], found[1]);
      changed = true;
    }

    removeUnusedProbes(file, variables.keys());
    return changed;
  },
};
