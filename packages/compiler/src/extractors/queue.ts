import ts from 'typescript';
import type { QueueMessageEntry } from '@spinajs/manifest';
import { dirname, join } from 'node:path';
import type { Extractor } from '../context.js';
import { findDecorator, literalValue } from '../decorators.js';

const FRAMEWORK_BASES = new Set(['QueueMessage', 'QueueEvent', 'QueueJob']);
const packageNames = new Map<string, string | undefined>();

function packageNameOf(directory: string): string | undefined {
  if (packageNames.has(directory)) return packageNames.get(directory);
  // lib/mjs and lib/cjs carry nameless `{ "type": ... }` package.json files; the name lives further up.
  const manifest = join(directory, 'package.json');
  let name = ts.sys.fileExists(manifest) ? (JSON.parse(ts.sys.readFile(manifest) ?? '{}') as { name?: string }).name : undefined;
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

export const extractQueueMessages: Extractor<QueueMessageEntry> = (ctx, file) => {
  const out: QueueMessageEntry[] = [];
  for (const st of file.statements) {
    if (!ts.isClassDeclaration(st) || !st.name) continue;
    const job = findDecorator(st, 'Job');
    const d = job ?? findDecorator(st, 'Event');
    if (!d) continue;
    out.push({
      className: st.name.text,
      kind: job ? 'job' : 'event',
      payload: ctx.typeRef(ctx.checker.getTypeAtLocation(st), st, undefined, { excludeMembersOf: isQueueFrameworkMember }),
      options: (literalValue(d.args[0], ctx) ?? {}) as Record<string, unknown>,
      source: ctx.sourceRef(st),
    });
  }
  return out;
};
