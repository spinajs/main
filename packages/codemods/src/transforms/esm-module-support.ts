import { CallExpression, ConditionalExpression, Expression, ExpressionStatement, Node, SourceFile, SyntaxKind } from 'ts-morph';
import type { Report, Transform } from '../index.js';

const noop: Report = () => undefined;

function unwrap(expr: Expression): Expression {
  let current = expr;
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

/** true when the probe is truthy under CommonJS, false when it is truthy under ESM, undefined when it is no probe */
function probePolarity(input: Expression): boolean | undefined {
  const expr = unwrap(input);
  if (!Node.isBinaryExpression(expr)) {
    return undefined;
  }

  const left = unwrap(expr.getLeft());
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

type Probes = Map<Node, boolean>;

/** keyed by declaration node, so a same-named variable in another scope is never matched */
function collectProbeVariables(file: SourceFile): Probes {
  const probes: Probes = new Map();
  for (const decl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = decl.getInitializer();
    const polarity = init ? probePolarity(init) : undefined;
    if (polarity !== undefined) {
      probes.set(decl, polarity);
    }
  }
  return probes;
}

function conditionPolarity(cond: Expression, probes: Probes): boolean | undefined {
  const expr = unwrap(cond);
  if (Node.isIdentifier(expr)) {
    for (const declaration of expr.getSymbol()?.getDeclarations() ?? []) {
      const polarity = probes.get(declaration);
      if (polarity !== undefined) {
        return polarity;
      }
    }
    return undefined;
  }
  return probePolarity(expr);
}

function esmBranch(node: ConditionalExpression, cjsWhenTrue: boolean): Expression {
  return cjsWhenTrue ? node.getWhenFalse() : node.getWhenTrue();
}

/** the 'mjs' branch of a path switch collapses to nothing; that is only safe as a dropped call argument */
function isReplaceable(node: ConditionalExpression, cjsWhenTrue: boolean): boolean {
  const branch = esmBranch(node, cjsWhenTrue);
  if (!Node.isStringLiteral(branch)) {
    return true;
  }
  const flat = branch
    .getLiteralValue()
    .split('/')
    .filter((segment) => segment !== 'mjs')
    .join('/');
  return flat !== '' || Node.isCallExpression(node.getParent());
}

function findProbeConditionals(file: SourceFile, probes: Probes): Array<[ConditionalExpression, boolean]> {
  const found: Array<[ConditionalExpression, boolean]> = [];
  for (const node of file.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    const polarity = conditionPolarity(node.getCondition(), probes);
    if (polarity !== undefined) {
      found.push([node, polarity]);
    }
  }
  return found;
}

function replaceWithEsmBranch(node: ConditionalExpression, cjsWhenTrue: boolean): void {
  const branch = esmBranch(node, cjsWhenTrue);

  if (!Node.isStringLiteral(branch)) {
    node.replaceWithText(branch.getText());
    return;
  }

  const flat = branch
    .getLiteralValue()
    .split('/')
    .filter((segment) => segment !== 'mjs')
    .join('/');

  if (flat !== '') {
    const quote = branch.getText()[0];
    node.replaceWithText(`${quote}${flat}${quote}`);
    return;
  }

  (node.getParent() as CallExpression).removeArgument(node);
}

function removeUnusedProbes(file: SourceFile): void {
  for (const decl of [...collectProbeVariables(file).keys()]) {
    if (decl.wasForgotten() || !Node.isVariableDeclaration(decl) || decl.findReferencesAsNodes().length > 0) {
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

function isEsmSupportCall(stmt: ExpressionStatement): boolean {
  const expr = stmt.getExpression();
  if (!Node.isCallExpression(expr)) {
    return false;
  }
  const callee = expr.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() === 'setESMModuleSupport' : callee.getText() === 'setESMModuleSupport';
}

function removeEsmSupportCalls(file: SourceFile): boolean {
  const calls = file.getDescendantsOfKind(SyntaxKind.ExpressionStatement).filter(isEsmSupportCall);

  for (const stmt of calls) {
    const parent = stmt.getParent();
    const inStatementList = Node.isBlock(parent) || Node.isSourceFile(parent) || Node.isModuleBlock(parent) || Node.isCaseClause(parent) || Node.isDefaultClause(parent);
    if (inStatementList) {
      stmt.remove();
    } else {
      stmt.replaceWithText('{}');
    }
  }
  return calls.length > 0;
}

export const esmModuleSupport: Transform = {
  name: 'esm-module-support',
  description: 'Removes DI.setESMModuleSupport() and the typeof module cjs/mjs switch',
  apply(_project, file, report = noop) {
    let changed = removeEsmSupportCalls(file);
    let replaced = false;

    for (;;) {
      const probes = collectProbeVariables(file);
      const next = findProbeConditionals(file, probes).find(([node, cjsWhenTrue]) => isReplaceable(node, cjsWhenTrue));
      if (!next) {
        break;
      }
      replaceWithEsmBranch(next[0], next[1]);
      changed = true;
      replaced = true;
    }

    for (const [node] of findProbeConditionals(file, collectProbeVariables(file))) {
      report(node, 'typeof module switch left in place: the mjs segment cannot be dropped here, check the built path by hand');
    }

    if (replaced) {
      removeUnusedProbes(file);
    }
    return changed;
  },
};
