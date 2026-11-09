import { Node, SyntaxKind } from 'ts-morph';
import type { Transform } from '../index.js';
import { insertNotes } from './notes.js';

export const PROBLEM_JSON_NOTE = '// TODO(spinajs-4): error bodies are application/problem+json, see docs/upgrading/4.0.md';

export const problemJsonNote: Transform = {
  name: 'problem-json-note',
  description: 'Adds a TODO above @HandleException usages: error bodies are application/problem+json in 4.0',
  apply(_project, file) {
    const decorators = file.getDescendantsOfKind(SyntaxKind.Decorator).filter((decorator) => {
      const expr = decorator.getExpression();
      const callee = Node.isCallExpression(expr) ? expr.getExpression() : expr;
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      return name === 'HandleException';
    });
    return insertNotes(file, decorators.map((node) => ({ node, note: PROBLEM_JSON_NOTE })));
  },
};
