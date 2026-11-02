import ts from 'typescript';

const hasModifier = (node: ts.HasModifiers, kind: ts.SyntaxKind): boolean => ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
const isExported = (node: ts.HasModifiers): boolean => hasModifier(node, ts.SyntaxKind.ExportKeyword) && !hasModifier(node, ts.SyntaxKind.DeclareKeyword);

/** An export's class; `null` for a value that is no class, which still takes part in a name collision. */
type Exported = ts.ClassDeclaration | null;

const isStarExport = (statement: ts.Statement): statement is ts.ExportDeclaration =>
  ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.exportClause && statement.moduleSpecifier !== undefined;

/**
 * What a module holds once compiled. Read from the statements and not from symbols, which see through a type-only alias:
 * `export type *` and a re-exported `import type` name a class and emit nothing.
 */
export class EmittedModules {
  private readonly exported = new Map<ts.SourceFile, Map<string, Exported>>();
  private readonly imported = new Map<ts.SourceFile, ts.SourceFile[]>();

  public constructor(
    private readonly checker: ts.TypeChecker,
    private readonly options: ts.CompilerOptions,
  ) {}

  /** What a module exports at runtime, by export name. */
  public exportsOf(file: ts.SourceFile): ReadonlyMap<string, Exported> {
    const known = this.exported.get(file);
    if (known) return known;

    const found = new Map<string, Exported>();
    // Set first: in an import cycle a module sees what is known of the other one so far.
    this.exported.set(file, found);
    for (const statement of file.statements) {
      if (!isStarExport(statement)) this.readExport(file, statement, found);
    }
    this.readStars(file, found);
    return found;
  }

  /** Classes a module exports at runtime. */
  public exportedClasses(file: ts.SourceFile): ts.ClassDeclaration[] {
    return [...this.exportsOf(file).values()].filter((e) => e !== null);
  }

  // Module semantics: a star never replaces a local or named export, and a name two stars bind differently is not exported.
  private readStars(file: ts.SourceFile, found: Map<string, Exported>): void {
    const starred = new Map<string, Exported>();
    const ambiguous = new Set<string>();

    for (const statement of file.statements.filter(isStarExport)) {
      const from = this.moduleOf(statement.moduleSpecifier as ts.Expression);
      for (const [name, declaration] of from ? this.exportsOf(from) : []) {
        if (name === 'default' || found.has(name)) continue;
        if (starred.has(name) && starred.get(name) !== declaration) ambiguous.add(name);
        starred.set(name, declaration);
      }
    }

    for (const [name, declaration] of starred) {
      if (!ambiguous.has(name)) found.set(name, declaration);
    }
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

  private readExport(file: ts.SourceFile, statement: ts.Statement, found: Map<string, Exported>): void {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) this.readExportDeclaration(file, statement, found);
    } else if (ts.isExportAssignment(statement)) {
      if (!statement.isExportEquals && ts.isIdentifier(statement.expression)) this.record(found, 'default', this.local(file, statement.expression.text));
    } else if (ts.canHaveModifiers(statement) && isExported(statement)) {
      this.readExportedDeclaration(file, statement, found);
    }
  }

  private readExportedDeclaration(file: ts.SourceFile, statement: ts.Statement, found: Map<string, Exported>): void {
    if (ts.isClassDeclaration(statement)) {
      const name = hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : statement.name?.text;
      if (name) found.set(name, statement);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      found.set(statement.name.text, null);
    } else if (ts.isVariableStatement(statement)) {
      this.readExportedVariables(file, statement, found);
    }
  }

  private readExportedVariables(file: ts.SourceFile, statement: ts.VariableStatement, found: Map<string, Exported>): void {
    for (const { name, initializer } of statement.declarationList.declarations) {
      if (!ts.isIdentifier(name)) continue;
      const declaration = initializer && ts.isIdentifier(initializer) ? this.local(file, initializer.text) : undefined;
      found.set(name.text, declaration ?? null);
    }
  }

  private record(found: Map<string, Exported>, name: string, declaration: Exported | undefined): void {
    if (declaration !== undefined) found.set(name, declaration);
  }

  private readExportDeclaration(file: ts.SourceFile, statement: ts.ExportDeclaration, found: Map<string, Exported>): void {
    const from = statement.moduleSpecifier && this.moduleOf(statement.moduleSpecifier);
    if ((statement.moduleSpecifier && !from) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) return;

    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly) continue;
      const name = (element.propertyName ?? element.name).text;
      this.record(found, element.name.text, from ? this.exportsOf(from).get(name) : this.local(file, name));
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
    if (clause.name?.text === name) return this.exportsOf(from).get('default') ?? undefined;
    if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return undefined;

    const element = clause.namedBindings.elements.find((e) => e.name.text === name && !e.isTypeOnly);
    return element && (this.exportsOf(from).get((element.propertyName ?? element.name).text) ?? undefined);
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
