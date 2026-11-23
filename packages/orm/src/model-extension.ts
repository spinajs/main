import type { Constructor } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';

import { ExtensionMethodCollision } from './exceptions.js';
import type { ModelBase } from './model.js';
import type { ModelBaseClass } from './model-registry.js';

export type { ModelBaseClass };

/** What a package adds to one model class under one name. */
export interface ModelMembers {
  /** Put on the class. `this` is the class the call is made on, so a subclass answers for itself. */
  readonly onModel?: (this: Constructor<ModelBase>, ...args: never[]) => unknown;
  /** Put on the prototype. `this` is the row. */
  readonly onRow?: (this: ModelBase, ...args: never[]) => unknown;
}

// What extendModel put on a class or a prototype: a second call replaces it, and a member of the model itself is never overwritten.
const installed = new WeakSet<object>();

function prototypeOf(model: ModelBaseClass): object {
  const prototype: unknown = model.prototype;
  if (typeof prototype !== 'object' || prototype === null) throw new InvalidArgument(`model extension: ${model.name} has no prototype`);
  return prototype;
}

// Walks the chain by descriptor rather than Reflect.get: a getter of ModelBase (Container, ModelDescriptor) must not run on a prototype.
function taken(owner: object, name: string): boolean {
  for (let current: unknown = owner; (typeof current === 'object' && current !== null) || typeof current === 'function'; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor === undefined) continue;
    const value: unknown = descriptor.value;
    return !(typeof value === 'function' && installed.has(value));
  }
  return false;
}

function put(owner: object, name: string, value: object | undefined): void {
  if (value === undefined) return;
  installed.add(value);
  // As installQueryExtensions defines a builder method: not enumerable, replaceable, removable.
  Object.defineProperty(owner, name, { value, writable: true, configurable: true, enumerable: false });
}

/**
 * Adds a member to one model class (`onModel`) and to its rows (`onRow`); subclasses inherit it, other models do not
 * get it. The typing is the model's own: an interface merged with the class for the rows, a `declare static` line for
 * the class. A column or field of the same name shadows the row member, because columns are own properties of a
 * hydrated row and are not on the prototype chain.
 *
 * @throws ExtensionMethodCollision when the model, its base classes or its prototype chain have a member of that name that this function did not install
 */
export function extendModel(model: ModelBaseClass, name: string, members: ModelMembers): void {
  const prototype = prototypeOf(model);
  if ((members.onModel !== undefined && taken(model, name)) || (members.onRow !== undefined && taken(prototype, name))) {
    throw new ExtensionMethodCollision(`model extension ${name}: ${model.name} already has a member of that name`);
  }
  put(model, name, members.onModel);
  put(prototype, name, members.onRow);
}

/** Removes what `extendModel` put on this class under `name`; a member the model declares or inherits stays. */
export function unextendModel(model: ModelBaseClass, name: string): void {
  for (const owner of [model, prototypeOf(model)]) {
    const own: unknown = Object.getOwnPropertyDescriptor(owner, name)?.value;
    if (typeof own === 'function' && installed.has(own)) Reflect.deleteProperty(owner, name);
  }
}
