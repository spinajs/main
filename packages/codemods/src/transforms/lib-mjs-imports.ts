import { ExportDeclaration, ImportDeclaration, Node, Project, SourceFile, SyntaxKind, ts } from 'ts-morph';
import type { Report, Transform } from '../index.js';

const noop: Report = () => undefined;

const LIB_SPECIFIER = /^(@spinajs\/[^/]+)\/lib\/(mjs|cjs)(\/.*)?$/;
const ROOT_REST = /^(\/(index(\.js)?)?)?$/;

interface Site {
  node: Node;
  value: string;
  set(value: string): void;
  decl?: ImportDeclaration | ExportDeclaration;
}

interface Leftover {
  node: Node;
  message: string;
}

function collectCallSites(file: SourceFile, sites: Site[]): void {
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const [arg] = call.getArguments();
    const isLoader = callee.getKind() === SyntaxKind.ImportKeyword || (Node.isIdentifier(callee) && callee.getText() === 'require');
    if (isLoader && arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))) {
      sites.push({ node: arg, value: arg.getLiteralValue(), set: (v) => arg.setLiteralValue(v) });
    }
  }
}

function collectSites(file: SourceFile): Site[] {
  const sites: Site[] = [];

  for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
    const literal = decl.getModuleSpecifier();
    if (literal) {
      sites.push({ node: literal, value: literal.getLiteralValue(), set: (v) => literal.setLiteralValue(v), decl });
    }
  }

  for (const ref of file.getDescendantsOfKind(SyntaxKind.ExternalModuleReference)) {
    const literal = ref.getExpression();
    if (Node.isStringLiteral(literal)) {
      sites.push({ node: literal, value: literal.getLiteralValue(), set: (v) => literal.setLiteralValue(v) });
    }
  }

  collectCallSites(file, sites);

  for (const type of file.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const arg = type.getArgument();
    const literal = Node.isLiteralTypeNode(arg) ? arg.getLiteral() : undefined;
    if (literal && Node.isStringLiteral(literal)) {
      sites.push({ node: literal, value: literal.getLiteralValue(), set: (v) => literal.setLiteralValue(v) });
    }
  }

  return sites;
}

/** names a named import/export brings in; undefined for default, namespace and side-effect forms */
function importedNames(decl?: ImportDeclaration | ExportDeclaration): string[] | undefined {
  if (Node.isImportDeclaration(decl)) {
    const names = decl.getNamedImports().map((s) => s.getName());
    return decl.getDefaultImport() || decl.getNamespaceImport() || names.length === 0 ? undefined : names;
  }
  if (Node.isExportDeclaration(decl)) {
    const names = decl.getNamedExports().map((s) => s.getName());
    return decl.isNamespaceExport() || names.length === 0 ? undefined : names;
  }
  return undefined;
}

function rootExports(project: Project, from: SourceFile, pkg: string): Set<string> | undefined {
  try {
    const resolved = ts.resolveModuleName(pkg, from.getFilePath(), project.getCompilerOptions(), project.getModuleResolutionHost()).resolvedModule;
    const root = resolved && project.addSourceFileAtPathIfExists(resolved.resolvedFileName);
    return root ? new Set(root.getExportedDeclarations().keys()) : undefined;
  } catch {
    return undefined;
  }
}

function reexportedByRoot(project: Project, file: SourceFile, pkg: string, decl?: ImportDeclaration | ExportDeclaration): boolean {
  const names = importedNames(decl);
  if (!names) {
    return false;
  }
  const exported = rootExports(project, file, pkg);
  return exported !== undefined && names.every((name) => exported.has(name));
}

function todoLine(message: string): string {
  return `// TODO(spinajs-4): ${message}`;
}

function insertTodos(file: SourceFile, leftovers: Leftover[]): boolean {
  const text = file.getFullText();
  const inserts = new Map<number, string>();

  for (const { node, message } of leftovers) {
    const statement = node.getFirstAncestor((a) => Node.isStatement(a)) ?? node;
    const lineStart = text.lastIndexOf('\n', statement.getStart() - 1) + 1;
    const previousLine = text.slice(text.lastIndexOf('\n', lineStart - 2) + 1, Math.max(lineStart - 1, 0)).trim();
    if (previousLine !== todoLine(message)) {
      inserts.set(lineStart, message);
    }
  }

  for (const [lineStart, message] of [...inserts].sort((a, b) => b[0] - a[0])) {
    const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
    file.insertText(lineStart, `${indent}${todoLine(message)}\n`);
  }
  return inserts.size > 0;
}

export const libMjsImports: Transform = {
  name: 'lib-mjs-imports',
  description: 'Rewrites @spinajs/<pkg>/lib/mjs/... imports to the flat lib/ layout',
  apply(project, file, report = noop) {
    let changed = false;
    const leftovers: Leftover[] = [];

    for (const site of collectSites(file)) {
      const match = LIB_SPECIFIER.exec(site.value);
      if (!match) {
        continue;
      }

      const [, pkg, flavour, rest = ''] = match;
      if (flavour === 'mjs' && (ROOT_REST.test(rest) || reexportedByRoot(project, file, pkg, site.decl))) {
        site.set(pkg);
        changed = true;
        continue;
      }

      const message =
        flavour === 'cjs'
          ? `"${site.value}": lib/cjs is gone in 4.x; import from "${pkg}" or an exported path`
          : `"${site.value}" is not an exported path in 4.x and "${pkg}" does not re-export it; check the package exports`;
      leftovers.push({ node: site.node, message });
      report(site.node, message);
    }

    return insertTodos(file, leftovers) || changed;
  },
};
