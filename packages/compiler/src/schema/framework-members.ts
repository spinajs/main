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

/** Members of the `@spinajs/queue` base classes are framework plumbing, not part of a message payload. */
export function isQueueFrameworkMember(declaration: ts.Declaration): boolean {
  const owner = declaration.parent;
  if (!ts.isClassLike(owner) || !owner.name || !FRAMEWORK_BASES.has(owner.name.text)) return false;
  return packageNameOf(dirname(declaration.getSourceFile().fileName)) === '@spinajs/queue';
}
