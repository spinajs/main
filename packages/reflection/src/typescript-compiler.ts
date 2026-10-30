import ts from 'typescript';

/**
 * Helper class for extracting various information from typescript source code
 */
export class TypescriptCompiler {
  private tsFile: string;

  private compiled: ts.Program;

  constructor(filename: string) {
    this.tsFile = filename;

    this.compiled = ts.createProgram([this.tsFile], {
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.Latest,
    });
  }

  /**
   *
   * Extracts all members info from typescript class eg. method name, parameters, return types etc.
   *
   * @param className - name of class to parse
   */
  public getClassMembers(className: string): Map<string, any> {
    const members: Map<string, ts.MethodDeclaration> = new Map<string, ts.MethodDeclaration>();

    const sourceFile = this.compiled.getSourceFile(this.tsFile);

    // Walk the tree to search for classes
    ts.forEachChild(
      sourceFile!,
      this.walkClassNode(
        className,
        this.walkMemberNode((method: ts.MethodDeclaration) => {
          // the program has no parent pointers, so getText() needs the source file passed in
          const name = ts.isComputedPropertyName(method.name) ? method.name.getText(sourceFile) : method.name.text;
          members.set(name, method);
        }),
      ),
    );

    return members;
  }

  private walkClassNode(className: string, callback: (classNode: ts.ClassDeclaration) => void) {
    return (node: ts.Node) => {
      if (node.kind === ts.SyntaxKind.ClassDeclaration) {
        const cldecl = node as ts.ClassDeclaration;
        if (cldecl.name?.text === className) {
          callback(cldecl);
        }
      }
    };
  }

  private walkMemberNode(callback: (methodNode: ts.MethodDeclaration) => void) {
    return (node: ts.ClassDeclaration) => {
      for (const member of node.members) {
        if (member.kind === ts.SyntaxKind.MethodDeclaration) {
          const method = member as ts.MethodDeclaration;
          callback(method);
        }
      }
    };
  }
}
