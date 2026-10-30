import ts from 'typescript';
import { dirname, join } from 'node:path';

const FRAMEWORK_BASES = new Set(['QueueMessage', 'QueueEvent', 'QueueJob']);
const packageNames = new Map<string, string | undefined>();

function readName(manifest: string): string | undefined {
  try {
    return (JSON.parse(ts.sys.readFile(manifest) ?? '{}') as { name?: string }).name;
  } catch {
    return undefined;
  }
}

function packageNameOf(directory: string): string | undefined {
  if (packageNames.has(directory)) return packageNames.get(directory);
  // A nested package.json can be a nameless `{ "type": ... }` marker; the name lives further up.
  const manifest = join(directory, 'package.json');
  let name = ts.sys.fileExists(manifest) ? readName(manifest) : undefined;
  if (!name && dirname(directory) !== directory) name = packageNameOf(dirname(directory));
  packageNames.set(directory, name);
  return name;
}

/** The npm package whose files declare `node`, or the file name when no package.json names one. */
export function declaringPackage(node: ts.Node): string {
  const file = node.getSourceFile().fileName;
  return packageNameOf(dirname(file)) ?? file;
}

export function isDeclaredIn(declaration: ts.Node | undefined, packageName: string): boolean {
  return !!declaration && packageNameOf(dirname(declaration.getSourceFile().fileName)) === packageName;
}

/** Members of the `@spinajs/queue` base classes are framework plumbing, not part of a message payload. */
export function isQueueFrameworkMember(declaration: ts.Declaration): boolean {
  const owner = declaration.parent;
  if (!ts.isClassLike(owner) || !owner.name || !FRAMEWORK_BASES.has(owner.name.text)) return false;
  return isDeclaredIn(declaration, '@spinajs/queue');
}

/** The instantiated base class, e.g. `Response<Buffer>` for `class BufferResponse extends Response<Buffer>`. */
export function baseClassOf(checker: ts.TypeChecker, type: ts.Type): ts.Type | undefined {
  const symbol = type.getSymbol();
  if (!symbol || !(symbol.flags & ts.SymbolFlags.Class)) return undefined;
  const declared = checker.getDeclaredTypeOfSymbol(symbol);
  return declared.flags & ts.TypeFlags.Object ? checker.getBaseTypes(declared as ts.InterfaceType)[0] : undefined;
}

/** `type` is the class `className` of `packageName` or extends it; matched by declaring package so a user class of the same name does not count. */
export function extendsFrameworkClass(checker: ts.TypeChecker, type: ts.Type, className: string, packageName: string): boolean {
  let current: ts.Type | undefined = type;
  for (let hops = 0; current && hops < 32; hops++) {
    const symbol = current.getSymbol();
    if (!symbol || !(symbol.flags & ts.SymbolFlags.Class)) return false;
    if (symbol.name === className && isDeclaredIn(symbol.declarations?.[0], packageName)) return true;
    current = baseClassOf(checker, current);
  }
  return false;
}
