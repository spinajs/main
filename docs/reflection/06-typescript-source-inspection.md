# TypeScript source inspection

`TypescriptCompiler` parses one `.ts` file with the TypeScript compiler API and returns the method declarations of a class in it. Use it in tooling that needs what runtime metadata loses: parameter names, optional markers, declared return types.

It is **not** used by the scan decorators, and it is not available in the `browser` build. Import it from the `@spinajs/reflection/typescript` subpath: the package root does not load `typescript`.

## How it works

1. `new TypescriptCompiler(filename)` calls `ts.createProgram([filename], { module: NodeNext, target: Latest })` at once. No `tsconfig.json` is read. The path can be absolute or relative to the working directory, with `/` or `\`.
2. `getClassMembers(className)` takes the program's source file for `filename`.
3. It walks the file's top-level statements and stops at every `ClassDeclaration` named `className`.
4. For each member of that class that is a `MethodDeclaration`, it stores the node under `method.name.text`, or under the source text of a computed name.
5. It returns the `Map<string, any>`; the values are `ts.MethodDeclaration` nodes.

## API

| Member | Behaviour |
| --- | --- |
| `new TypescriptCompiler(filename: string)` | Builds a TypeScript program for the file. Cost grows with the file's imports, which the program also parses |
| `getClassMembers(className: string): Map<string, any>` | Method name to `ts.MethodDeclaration`. Empty when the class or the file is not found |

What `getClassMembers()` returns for each kind of member:

| Member in the class | In the map |
| --- | --- |
| Instance method, `async` method | Yes, under its name |
| `static` method | Yes, under its name |
| `#private` method | Yes, under `#name` |
| Overloaded method | Once; the last declaration, which is the implementation |
| Computed name, eg. `[Symbol.iterator]()` | Yes, under its source text, eg. `[Symbol.iterator]` |
| Constructor, property, getter, setter | No |
| A class inside a `namespace`, function or class expression | Not found |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `TypescriptCompiler` | Not registered in DI; created with `new`, one per file | `TypescriptCompiler` | none shipped | Subclass and add methods built on `getClassMembers()`. The program, the file name and the tree walkers are `private`, so a subclass reaches the tree only through `getClassMembers()` |

### `TypescriptCompiler`: extend it

`Node.getText()` on a returned node throws, because the program is built without parent pointers. Read the source text with the node's `pos` and `end` instead. The subclass below adds a method that lists each action with its parameter list and return type.

```ts sample
import { readFileSync } from 'fs';
import ts from 'typescript';
import { TypescriptCompiler } from '@spinajs/reflection/typescript';

export interface ActionSignature {
  name: string;
  parameters: { name: string; optional: boolean; type: string }[];
  returns: string;
}

export class ActionSignatureReader extends TypescriptCompiler {
  private readonly source: string;

  constructor(private readonly file: string) {
    super(file);
    this.source = readFileSync(file, 'utf8');
  }

  public getActions(className: string): ActionSignature[] {
    const methods = this.getClassMembers(className) as Map<string, ts.MethodDeclaration>;

    return [...methods.entries()]
      .filter(([name]) => !name.startsWith('#') && !name.startsWith('['))
      .map(([name, method]) => ({
        name,
        parameters: method.parameters.map((p) => ({
          name: ts.isIdentifier(p.name) ? p.name.text : this.text(p.name),
          optional: p.questionToken !== undefined || p.initializer !== undefined,
          type: p.type ? this.text(p.type) : 'any',
        })),
        returns: method.type ? this.text(method.type) : 'inferred',
      }));
  }

  // `pos` includes leading trivia, so trim it.
  private text(node: ts.Node): string {
    return this.source.slice(node.pos, node.end).trim();
  }
}

const reader = new ActionSignatureReader('src/controllers/InvoiceController.ts');
for (const action of reader.getActions('InvoiceController')) {
  const params = action.parameters.map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ');
  console.log(`${action.name}(${params}): ${action.returns}`);
}
// list(page: number, size?: number): string[]
```

## Important behaviour

- **Construction is the expensive step.** It parses the file and everything it imports. Keep one instance per file and call `getClassMembers()` on it as often as needed.
- **No `tsconfig.json`.** Path aliases and `paths` mappings are not applied; only `module: NodeNext` and the latest target are set.
- **Only top-level classes are found.** An exported or non-exported top-level `class` works; nested classes do not.
- **A missing file or class is not an error.** Both return an empty `Map`; check `size` when a result is required.
- **Node text needs the source.** `getText()` without a source file throws `Cannot read properties of undefined`.

## Best practices

- Cast the result to `Map<string, ts.MethodDeclaration>` and use the `ts.is*()` guards on its nodes.
- Run it at build or cache-generation time, not per request.
- Skip keys that start with `#` or `[` when you list public methods.

## Related

- [Controller cache and CLI](../http/21-controller-cache-and-cli.md): `@spinajs/http` caches controller source data for similar tooling.
- [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API): the node types `getClassMembers()` returns.
