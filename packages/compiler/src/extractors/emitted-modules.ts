import ts from 'typescript';

const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean => ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
const isExported = (node: ts.HasModifiers): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword);

/**
 * What a module holds once compiled. Read from the statements and not from symbols, which see through a type-only alias:
 * `export type *` and a re-exported `import type` name a class and emit nothing.
 */
export class EmittedModules {
  private readonly exported = new Map<ts.SourceFile, Map<string, ts.ClassDeclaration>>();
  private readonly imported = new Map<ts.SourceFile, ts.SourceFile[]>();

  public constructor(
    private readonly checker: ts.TypeChecker,
    private readonly options: ts.CompilerOptions,
  ) {}

  /** Classes a module exports at runtime, by export name. */
  public exportsOf(file: ts.SourceFile): ReadonlyMap<string, ts.ClassDeclaration> {
    const known = this.exported.get(file);
    if (known) return known;

    const found = new Map<string, ts.ClassDeclaration>();
    // Set first: in an import cycle a module sees what is known of the other one so far.
    this.exported.set(file, found);
    for (const statement of file.statements) this.readExport(file, statement, found);
    return found;
  }

  /** `files` and everything they load, through the imports that survive compilation. */
  public closureOf(files: readonly ts.SourceFile[]): Set<ts.SourceFile> {
    const seen = new Set(files);
    for (const file of seen) {
      for (const next of this.importsOf(file)) seen.add(next);
    }
    return seen;
  }

  private moduleOf(specifier: ts.Expression): ts.SourceFile | undefined {
    const declaration = this.checker.getSymbolAtLocation(specifier)?.valueDeclaration;
    return declaration && ts.isSourceFile(declaration) && !declaration.isDeclarationFile ? declaration : undefined;
  }

  private readExport(file: ts.SourceFile, statement: ts.Statement, found: Map<string, ts.ClassDeclaration>): void {
    if (ts.isClassDeclaration(statement) && isExported(statement)) {
      const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text;
      if (name) found.set(name, statement);
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      this.record(found, 'default', this.local(file, statement.expression.text));
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name) && initializer && ts.isIdentifier(initializer)) this.record(found, name.text, this.local(file, initializer.text));
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      this.readExportDeclaration(file, statement, found);
    }
  }

  private record(found: Map<string, ts.ClassDeclaration>, name: string, declaration: ts.ClassDeclaration | undefined): void {
    if (declaration) found.set(name, declaration);
  }

  private readExportDeclaration(file: ts.SourceFile, statement: ts.ExportDeclaration, found: Map<string, ts.ClassDeclaration>): void {
    const from = statement.moduleSpecifier && this.moduleOf(statement.moduleSpecifier);
    if (statement.moduleSpecifier && !from) return;

    if (!statement.exportClause) {
      for (const [name, declaration] of from ? this.exportsOf(from) : []) {
        if (name !== 'default') found.set(name, declaration);
      }
    } else if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const name = (element.propertyName ?? element.name).text;
        this.record(found, element.name.text, from ? this.exportsOf(from).get(name) : this.local(file, name));
      }
    }
  }

  /** The class a top-level name holds at runtime. */
  private local(file: ts.SourceFile, name: string, seen = new Set<string>()): ts.ClassDeclaration | undefined {
    if (seen.has(name)) return undefined;
    seen.add(name);

    for (const statement of file.statements) {
      if (ts.isClassDeclaration(statement) && statement.name?.text === name && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return statement;
      if (ts.isImportDeclaration(statement)) {
        const imported = this.fromImport(statement, name);
        if (imported) return imported;
      }
      if (ts.isVariableStatement(statement)) {
        const initializer = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name)?.initializer;
        if (initializer && ts.isIdentifier(initializer)) return this.local(file, initializer.text, seen);
      }
    }
    return undefined;
  }

  private fromImport(statement: ts.ImportDeclaration, name: string): ts.ClassDeclaration | undefined {
    const clause = statement.importClause;
    const from = clause && !clause.isTypeOnly ? this.moduleOf(statement.moduleSpecifier) : undefined;
    if (!clause || !from) return undefined;
    if (clause.name?.text === name) return this.exportsOf(from).get('default');
    if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return undefined;

    const element = clause.namedBindings.elements.find((e) => e.name.text === name && !e.isTypeOnly);
    return element && this.exportsOf(from).get((element.propertyName ?? element.name).text);
  }

  private importsOf(file: ts.SourceFile): ts.SourceFile[] {
    const known = this.imported.get(file);
    if (known) return known;

    // A single file's transpile elides what the file uses only as a type; it cannot know that a name is an interface.
    const { outputText } = ts.transpileModule(file.text, { compilerOptions: { ...this.options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }, fileName: file.fileName });
    const emitted = new Set(ts.preProcessFile(outputText).importedFiles.map((f) => f.fileName));

    const found = file.statements.flatMap((statement) => {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return [];
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteralLike(specifier) || !emitted.has(specifier.text) || !this.carriesValue(statement)) return [];
      const target = this.moduleOf(specifier);
      return target ? [target] : [];
    });
    this.imported.set(file, found);
    return found;
  }

  private carriesValue(statement: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
    const names = ts.isImportDeclaration(statement) ? this.importedNames(statement) : this.exportedNames(statement);
    return names === undefined || names.some((id) => this.isValue(id));
  }

  // `undefined`: the statement loads its module whatever it names.
  private importedNames(statement: ts.ImportDeclaration): ts.Identifier[] | undefined {
    const clause = statement.importClause;
    if (!clause) return undefined;
    if (clause.isTypeOnly) return [];
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return undefined;
    const named = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements.filter((e) => !e.isTypeOnly).map((e) => e.name) : [];
    return clause.name ? [clause.name, ...named] : named;
  }

  private exportedNames(statement: ts.ExportDeclaration): ts.Identifier[] | undefined {
    if (statement.isTypeOnly) return [];
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return undefined;
    return statement.exportClause.elements.filter((e) => !e.isTypeOnly && ts.isIdentifier(e.name)).map((e) => e.name as ts.Identifier);
  }

  private isValue(id: ts.Identifier): boolean {
    const symbol = this.checker.getSymbolAtLocation(id);
    const target = symbol && symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    return !target || (target.flags & ts.SymbolFlags.Value) !== 0;
  }
}
