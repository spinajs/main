import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { TypedArray } from './array.js';
import { getTypeName, isConstructor, isFactory, isObject } from './helpers.js';
import { IChainRegistration, IContainer } from './interfaces.js';
import { Class, Factory } from './types.js';
import { BindException } from './exceptions.js';

const sourceOf = (type: Class<unknown>) => Function.prototype.toString.call(type);

/**
 * A package loaded twice ( a linked checkout, an install in two places ) evaluates its classes again: another
 * identity, the same source. Two different classes whose source is identical cannot be told from such a copy.
 */
function isSameClass(a: Class<unknown>, b: Class<unknown>) {
  return a === b || sourceOf(a) === sourceOf(b);
}

const shorten = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);

/**
 * The text before the class body; a `{` inside the heritage clause, eg. `extends mixin({ ... })`, is not the body.
 * Brackets inside string literals are counted too, so when no body brace is found the first line stands in.
 */
function declarationOf(source: string) {
  let depth = 0;
  let end = -1;
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (c === '(' || c === '[') {
      depth++;
    } else if (c === ')' || c === ']') {
      depth--;
    } else if (c === '{' && depth === 0) {
      end = i;
      break;
    }
  }
  const head = end === -1 ? source.split('\n')[0] : source.slice(0, end);
  return shorten(head.replace(/\s+/g, ' ').trim());
}

function describeBoth(registered: Class<unknown>, refused: Class<unknown>) {
  const [a, b] = [sourceOf(registered), sourceOf(refused)];
  const [headA, headB] = [declarationOf(a), declarationOf(b)];
  if (headA !== headB) {
    return `registered: ${headA}; refused: ${headB}`;
  }

  const [linesA, linesB] = [a, b].map((s) => s.split('\n').map((l) => l.trim()));
  const count = Math.max(linesA.length, linesB.length);
  let at = 0;
  while (at < count && linesA.at(at) === linesB.at(at)) {
    at++;
  }
  if (at === count) {
    return `both ${headA}, they differ in whitespace only`;
  }
  const line = (lines: string[]) => {
    const text = lines.at(at);
    return text === undefined ? 'the end of the class' : `"${shorten(text)}"`;
  };
  return `both ${headA}, they differ at line ${at + 1}: registered has ${line(linesA)}, refused has ${line(linesB)}`;
}

function duplicateName(key: string, registered: Class<unknown>, refused: Class<unknown>) {
  const name = getTypeName(refused);
  return new BindException(
    `Two different classes named ${name} cannot both be registered as ${key} (${describeBoth(registered, refused)}). ` +
      `Give one of them another name. To replace a registered class, register the new class under another name: DI.register(New${name}).as(${name}).`,
  );
}

export class Registry {
  protected registry: Map<string, any[]> = new Map<string, any[]>();

  constructor(protected container: IContainer) { }

  public clear() {
    this.registry.clear();
  }

  /**
   * True when this registry ( not an ancestor ) holds an entry for `service`.
   */
  public ownsRegistration<T>(service: TypedArray<T> | Class<T> | string): boolean {
    return this.registry.has(getTypeName(service));
  }

  /**
   * Without `implementation`: removes every entry named like `type`, under any key.
   * With it: removes `implementation` itself ( by identity, so one of several arrow factories ) from the `type` key only.
   */
  public unregister(type: any, implementation?: unknown) {
    const tname = getTypeName(type);
    const byIdentity = implementation !== undefined;

    for (const [key, value] of [...this.registry]) {
      if (byIdentity && key !== tname) {
        continue;
      }

      const index = byIdentity ? value.indexOf(implementation) : value.findIndex((x) => getTypeName(x) === tname);
      if (index === -1) {
        continue;
      }

      value.splice(index, 1);
      // An empty list would still count as a registration and hide the default
      // resolution ( the type itself, or the parent's entries ).
      if (value.length === 0) {
        this.registry.delete(key);
      }
    }
  }

  public register(name: string | Class<any> | TypedArray<any>, type: any) {
    if (!isConstructor(type) && !isFactory(type) && !isObject(type)) {
      throw new InvalidOperation('cannot register type if its not an class or factory function');
    } else {
      const tname = getTypeName(name);
      const value = this.registry.get(tname);

      if (value) {
        // factory functions, we always add to registry
        // its impossible to check for duplicates
        // all would return 'Function' type
        if (isFactory(type)) {
          value.push(type);
        } else {
          const registered = value.find((v) => getTypeName(v) === getTypeName(type));
          if (!registered) {
            value.push(type);
          } else if (isConstructor(type) && isConstructor(registered) && !isSameClass(registered, type)) {
            throw duplicateName(tname, registered, type);
          }
        }
      } else {
        this.registry.set(tname, [type]);
      }
    }
  }

  public hasRegisteredType(source: Class<any> | string | TypedArray<any>, type: Class<any> | string | TypedArray<any> | object, parent?: boolean) {
    const sourceName = getTypeName(source);
    const targetName = getTypeName(type);
    if (this.registry.has(sourceName)) {
      return this.registry.get(sourceName)!.find((s) => s.name === targetName) !== undefined;
    } else if (parent && this.container.Parent) {
      return this.container.Parent.hasRegisteredType(source, type, parent);
    }
    return false;
  }

 public getTypes<T>(service: string | Class<T> | TypedArray<T>, parent = true): Array<Class<unknown> | Factory<unknown>> {
    if (!service) {
      throw new InvalidArgument('argument "service" cannot be null or empty');
    }

    const name = getTypeName(service);

    if (this.registry.has(name)) {
      return this.registry.get(name)!;
    }

    if (this.container.Parent && parent) {
      return this.container.Parent.getRegisteredTypes(service, parent);
    }

    return null as any;
  }

  public getTypesChain<T>(service: string | Class<T> | TypedArray<T>): IChainRegistration[] {
    if (!service) {
      throw new InvalidArgument('argument "service" cannot be null or empty');
    }

    const lineage: IContainer[] = [];
    for (let c: IContainer | undefined = this.container; c; c = c.Parent) {
      lineage.unshift(c);
    }

    const chain: IChainRegistration[] = [];
    for (const container of lineage) {
      for (const type of container.Registry.getTypes(service, false) ?? []) {
        const name = isFactory(type) ? null : getTypeName(type);
        const replaced = name === null ? -1 : chain.findIndex((e) => !isFactory(e.type) && getTypeName(e.type) === name);

        if (replaced === -1) {
          chain.push({ type, container });
        } else {
          chain[replaced] = { type, container };
        }
      }
    }

    return chain;
  }

  public hasRegistered<T>(service: TypedArray<T> | Class<T> | string, parent = true): boolean {
    if (this.registry.has(getTypeName(service))) {
      return true;
    } else if (parent && this.container.Parent) {
      return this.container.Parent.hasRegistered(service, parent);
    }

    return false;
  }
}
