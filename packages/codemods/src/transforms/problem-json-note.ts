import { Node, SyntaxKind } from 'ts-morph';
import type { Transform } from '../index.js';

export const PROBLEM_JSON_NOTE = '// TODO(spinajs-4): error bodies are application/problem+json, see docs/upgrading/4.0.md';

export const problemJsonNote: Transform = {
  name: 'problem-json-note',
  description: 'Adds a TODO above @HandleException usages: error bodies are application/problem+json in 4.0',
  apply(_project, file) {
    const text = file.getFullText();
    const lineStarts = new Set<number>();

    for (const decorator of file.getDescendantsOfKind(SyntaxKind.Decorator)) {
      const expr = decorator.getExpression();
      const callee = Node.isCallExpression(expr) ? expr.getExpression() : expr;
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      if (name !== 'HandleException') {
        continue;
      }

      const lineStart = text.lastIndexOf('\n', decorator.getStart() - 1) + 1;
      const previousLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0)).trim();
      if (previousLine !== PROBLEM_JSON_NOTE) {
        lineStarts.add(lineStart);
      }
    }

    // inserting from the end keeps the earlier offsets valid
    for (const lineStart of [...lineStarts].sort((a, b) => b - a)) {
      const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
      file.insertText(lineStart, `${indent}${PROBLEM_JSON_NOTE}\n`);
    }

    return lineStarts.size > 0;
  },
};
