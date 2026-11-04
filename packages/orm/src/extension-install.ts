import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import type { QueryBuilder } from './builders/base.js';
import { DeleteQueryBuilder } from './builders/delete.js';
import { InsertQueryBuilder } from './builders/insert.js';
import { setCloneHooks } from './builders/internal.js';
import { SelectQueryBuilder } from './builders/select.js';
import { UpdateQueryBuilder } from './builders/update.js';
import { ExtensionMethodCollision } from './exceptions.js';
import { DeleteQueryExtension, InsertQueryExtension, SelectQueryExtension, UpdateQueryExtension } from './extensions.js';
import type { QueryExtension } from './extensions.js';

interface Addition {
  readonly prototype: object;
  readonly method: string;
  readonly fn: QueryExtension['methods'][string];
}

// One row per builder: the extension base its extensions subclass, and the name used in messages.
const TARGETS = [
  { name: 'select', base: SelectQueryExtension, builder: SelectQueryBuilder },
  { name: 'update', base: UpdateQueryExtension, builder: UpdateQueryBuilder },
  { name: 'delete', base: DeleteQueryExtension, builder: DeleteQueryBuilder },
  { name: 'insert', base: InsertQueryExtension, builder: InsertQueryBuilder },
] as const;

// Prototypes outlive an Orm: each install first removes what the previous one added, so a process
// that resolves the Orm again (tests do) ends up with exactly the current extension set.
let installed: readonly Addition[] = [];

function targetOf(extension: QueryExtension): (typeof TARGETS)[number] {
  const target = TARGETS.find((t) => extension instanceof t.base);
  if (target === undefined) {
    const bases = TARGETS.map((t) => t.base.name);
    throw new InvalidArgument(`query extension ${extension.name} extends QueryExtension directly; extend ${bases.slice(0, -1).join(', ')} or ${bases[bases.length - 1]}`);
  }
  return target;
}

function replacedBySubclass(extension: QueryExtension, all: readonly QueryExtension[]): boolean {
  return all.some((other) => other.constructor !== extension.constructor && other instanceof extension.constructor);
}

function additionsOf(extensions: readonly QueryExtension[]): Addition[] {
  const owners = new Map<object, Map<string, string>>();
  const additions: Addition[] = [];
  for (const extension of extensions) {
    const { name: target, builder } = targetOf(extension);
    const prototype: object = builder.prototype;
    const taken = owners.get(prototype) ?? new Map<string, string>();
    owners.set(prototype, taken);
    for (const [method, fn] of Object.entries(extension.methods)) {
      const other = taken.get(method);
      if (other !== undefined) throw new ExtensionMethodCollision(`query extensions ${other} and ${extension.name} both add ${method} to the ${target} builder`);
      if (method in prototype) throw new ExtensionMethodCollision(`query extension ${extension.name} adds ${method} to the ${target} builder, which already has it`);
      taken.set(method, extension.name);
      additions.push({ prototype, method, fn });
    }
  }
  return additions;
}

/** Every extension registered under one of the four bases. */
export async function resolveQueryExtensions(container: IContainer): Promise<QueryExtension[]> {
  const extensions: QueryExtension[] = [];
  for (const { base } of TARGETS) extensions.push(...(await container.resolve(Array.ofType(base))));
  return extensions;
}

/** Installs `extensions` on the builder prototypes, replacing whatever the previous call installed. */
export function installQueryExtensions(extensions: readonly QueryExtension[]): void {
  for (const { prototype, method } of installed) Reflect.deleteProperty(prototype, method);
  installed = [];
  setCloneHooks([]);

  const active = extensions.filter((e) => !replacedBySubclass(e, extensions));
  const additions = additionsOf(active);
  for (const { prototype, method, fn } of additions) {
    Object.defineProperty(prototype, method, { value: fn, writable: true, configurable: true, enumerable: false });
  }
  installed = additions;
  setCloneHooks(active.map((e) => (source: QueryBuilder, clone: QueryBuilder) => e.onClone?.(source, clone)));
}
