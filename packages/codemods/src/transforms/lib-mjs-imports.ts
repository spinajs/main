import { Node, StringLiteral, SyntaxKind } from 'ts-morph';
import type { Transform } from '../index.js';

const LIB_MJS = /^(@spinajs\/[^/]+)\/lib\/mjs(\/.*)?$/;

export function rewriteSpecifier(specifier: string): string | undefined {
  const match = LIB_MJS.exec(specifier);
  if (!match) {
    return undefined;
  }

  const [, pkg, rest = ''] = match;
  return rest === '' || rest === '/index.js' ? pkg : `${pkg}/lib${rest}`;
}

export const libMjsImports: Transform = {
  name: 'lib-mjs-imports',
  description: 'Rewrites @spinajs/<pkg>/lib/mjs/... imports to the flat lib/ layout',
  apply(_project, file) {
    const literals: StringLiteral[] = [];

    for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const specifier = decl.getModuleSpecifier();
      if (specifier) {
        literals.push(specifier);
      }
    }

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const [arg] = call.getArguments();
      if (call.getExpression().getKind() === SyntaxKind.ImportKeyword && arg && Node.isStringLiteral(arg)) {
        literals.push(arg);
      }
    }

    let changed = false;
    for (const literal of literals) {
      const rewritten = rewriteSpecifier(literal.getLiteralValue());
      if (rewritten !== undefined) {
        literal.setLiteralValue(rewritten);
        changed = true;
      }
    }

    return changed;
  },
};
