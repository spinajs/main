import { ResolveType } from './enums.js';
import { IAutoinjectOptions, IContainer, IInjectDescriptor, IToInject } from './interfaces.js';
import { ResolveException } from './exceptions.js';
import { Class } from './types.js';
import { TypedArray } from './array.js';
import * as DI from './root.js';
import { notePendingProperty, PROPERTY_TYPE_RESOLVER } from './property-type.js';
import { getTypeName, isChainArray, isConstructor, isPromise, isTypedArray } from './helpers.js';

export const DI_DESCRIPTION_SYMBOL = '__DI_INJECTION_DESCRIPTOR__';

/**
 * The descriptor owned by `target`. A new one keeps the lifetime of the nearest decorated base class,
 * because `extractDescriptor` takes the lifetime from the nearest descriptor only.
 */
function ownDescriptor(target: object): IInjectDescriptor<unknown> {
  let descriptor = Reflect.getOwnMetadata(DI_DESCRIPTION_SYMBOL, target) as IInjectDescriptor<unknown>;
  if (!descriptor) {
    const inherited = Reflect.getMetadata(DI_DESCRIPTION_SYMBOL, target) as IInjectDescriptor<unknown> | undefined;
    descriptor = {
      inject: [],
      resolver: inherited ? inherited.resolver : ResolveType.Singleton,
    };

    Reflect.defineMetadata(DI_DESCRIPTION_SYMBOL, descriptor, target);
  }

  return descriptor;
}

export function AddDependencyForProperty(callback?: (descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    const descriptor = ownDescriptor(target.constructor);

    if (callback) {
      callback(descriptor, target, propertyKey, indexOrDescriptor);
    }
  };
}

export function AddDependency(callback?: (descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    const descriptor = ownDescriptor(target);

    if (callback) {
      callback(descriptor, target, propertyKey, indexOrDescriptor);
    }
  };
}

/**
 *
 * Class with this decorator is automatically registered in DI container an can be resolved.
 * NOTE: we dont need to register class before resolving. Injectable decorator is mainly used in extensions & plugins
 * to register implementation that can be resolved by framework or other parts without knowing about specific implementations eg.
 * avaible database drivers.
 *
 * @param as - register class in DI container as something else.
 *
 * @example
 * ```typescript
 *
 * @Injectable(OrmDriver)
 * class MysqlOrmDriver{
 *
 * // implementation ...
 * }
 *
 *
 * // somewhere else in code
 * const avaibleDrivers = DI.resolve(Array.of(OrmDriver));
 *
 *
 * ```
 *
 */
export function Injectable(as?: Class<unknown> | string) {
  return (target: Class<unknown>) => {
    if (as) {
      DI.register(target).as(as);
    }
    DI.register(target).asSelf();
  };
}

/**
 * Sets dependency injection guidelines - what to inject for specified class. If multiple instances are registered at specified type,
 * only first one is resolved and injected
 * @param args - what to inject - class definitions
 * @example
 * ```javascript
 *
 * @Inject(Bar)
 * class Foo{
 *
 *  @Inject(Bar)
 *  barInstance : Bar;
 *
 *  constructor(bar : Bar){
 *      // bar is injected when Foo is created via DI container
 *      this.barInstance = bar;
 *  }
 *
 *  someFunc(){
 *
 *    this._barInstance.doSmth();
 *  }
 * }
 *
 * ```
 */
export function Inject(...args: (Class<any> | TypedArray<any>)[]) {
  return AddDependency((descriptor: IInjectDescriptor<unknown>) => {
    for (const a of args) {
      // avoid injecting duplicates
      if (
        !descriptor.inject.find((i) => {
          if (isTypedArray(i)) {
            if (isTypedArray(a)) {
              return i.Type === a.Type;
            } else {
              return i.Type === a;
            }
          } else {
            return !i.autoinject && i.inject === a;
          }
        })
      ) {
        descriptor.inject.push({
          autoinject: false,
          autoinjectKey: '',
          inject: a,
          mapFunc: undefined,
        });
      }
    }
  });
}

/**
 * Automatically injects dependency based on reflected property type. Uses experimental typescript reflection api
 * If decorator is applied to array property all registered type instances are injected, otherwise only first / only that exists
 *
 * @param injectType - when injecting array of some type, type must be explicitly provided. Typescript reflection cant reflect declared array types.
 *                     `Array.ofType(T)` is the same as `T` on an array property;
 *                     `Array.chainOf(T)` injects the registrations of the resolving container and all its ancestors
 * @param mapFunc - when injecting array we sometimes need services mapped by some kind of key, so later we dont need to search o(n) elements for specific service, but reference by key/name
 * @example
 * ```javascript
 * class Foo{
 *
 *  @Autoinject
 *  barInstance : Bar;
 *
 *  constructor(){
 *      // ....
 *  }
 *
 *  someFunc(){
 *
 *    // automatically injected dependency is avaible now
 *    this.barInstance.doSmth();
 *  }
 * }
 *
 * ```
 */
export function Autoinject<T>(typeOrOptions?: Class<T> | TypedArray<T> | IAutoinjectOptions<T>, options?: IAutoinjectOptions<T>) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol) => {
    // undefined when the build emits no decorator metadata (esbuild, tsx)
    const declaredType = Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown> | undefined;
    const isArray = declaredType?.name === 'Array' || declaredType?.name === 'Map';
    let opt = options;

    if (typeOrOptions instanceof TypedArray) {
      if (opt?.check || opt?.optional) {
        throw new Error(`@Autoinject: check and optional take a single class, ${String(propertyKey)} is an array or map`);
      }
      if (declaredType && !isArray) {
        throw new Error(`@Autoinject(${listName(typeOrOptions)}) needs an array or map property, ${String(propertyKey)} is not one`);
      }

      descriptor.inject.push({
        autoinject: true,
        autoinjectKey: propertyKey,
        inject: typeOrOptions,
        mapFunc: opt?.mapFunc,
        options: opt?.options,
      });
      return;
    }

    const explicit = isConstructor(typeOrOptions) ? typeOrOptions : undefined;
    if (!explicit) {
      opt = typeOrOptions as IAutoinjectOptions<T> | undefined;

      if (isArray && !opt?.check && !opt?.optional) {
        throw new Error(`@Autoinject: you must provide inject type when injecting array or map, ${String(propertyKey)} has none`);
      }
    }

    if (!declaredType) {
      const declared = opt;
      notePendingProperty(target.constructor as Class<unknown>, String(propertyKey));
      descriptor.inject.push({
        autoinject: true,
        autoinjectKey: propertyKey,
        inject: explicit ?? Object,
        pendingType: { property: propertyKey, explicit, bind: (resolved, isList) => propertyInjection(resolved, propertyKey, declared, isList) },
      });
      return;
    }

    descriptor.inject.push(propertyInjection(explicit ?? declaredType, propertyKey, opt, isArray));
  });
}

function propertyInjection<T>(type: Class<unknown>, propertyKey: string | symbol, opt: IAutoinjectOptions<T> | undefined, isArray: boolean): IToInject<unknown> {
  if (opt?.check || opt?.optional) {
    if (opt.check && opt.optional) {
      throw new Error('@Autoinject: check and optional exclude each other');
    }
    if (isArray) {
      throw new Error(`@Autoinject: check and optional take a single class, ${String(propertyKey)} is an array or map`);
    }
    const args = opt.options !== undefined ? [opt.options] : undefined;
    return {
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: type,
      // A synchronous throw would leave the already started async siblings unhandled; reject instead.
      resolveFunc: (_data: unknown, container: IContainer) => {
        try {
          return opt.optional ? container.resolveOptional(type, args) : container.resolve(type, args, true);
        } catch (e) {
          return Promise.reject(e);
        }
      },
    };
  }

  return {
    autoinject: true,
    autoinjectKey: propertyKey,
    inject: isArray ? Array.ofType(type) : type,
    mapFunc: opt?.mapFunc,
    options: opt?.options,
  };
}

function listName(list: TypedArray<unknown>) {
  return `Array.${isChainArray(list) ? 'chainOf' : 'ofType'}(${getTypeName(list)})`;
}

function toMap(value: unknown, mapFunc: (x: any) => string | undefined) {
  if (!Array.isArray(value)) {
    return value;
  }
  const map = new Map<string, unknown>();
  for (const v of value) {
    const key = mapFunc(v);
    if (key !== undefined) {
      map.set(key, v);
    }
  }
  return map;
}

class LazyInjectBinding {
  constructor(
    public readonly container: IContainer,
    public readonly type: unknown,
  ) {}
}

/**
 * Lazy injects service to object. Use only with class properties
 *
 * The service is resolved on every read, in the container that built the owner; an owner made with `new` reads the root container.
 *
 * @param service - class or name of service to inject. On an array or map property a class means `Array.ofType(service)`;
 *                  `Array.ofType(T)` and `Array.chainOf(T)` can be passed explicitly
 * @param options - `mapFunc` turns the resolved list into a map keyed by its result
 *
 * @example
 * ```javascript
 *
 * class Foo{
 * ...
 *
 *  @LazyInject(Bar)
 *  _barInstance : Bar; // _barInstance is not yet resolved
 *
 *  someFunc(){
 *    // barInstance is resolved only when first accessed
 *    this._barInstance.doSmth();
 *  }
 * }
 *
 * ```
 */
export function LazyInject<T>(service?: Class<T> | TypedArray<T> | string, options?: Pick<IAutoinjectOptions<T>, 'mapFunc'>) {
  return (target: any, key: string) => {
    const declared = Reflect.getMetadata('design:type', target, key) as Class<unknown> | undefined;
    const isList = declared?.name === 'Array' || declared?.name === 'Map';

    // A list with async elements resolves to a promise, so such a property is typed Promise<T[]>.
    if (service instanceof TypedArray && declared && !isList && declared.name !== 'Promise') {
      throw new Error(`@LazyInject(${listName(service)}) needs an array, map or promise property, ${key} is not one`);
    }
    if (isList && !service) {
      throw new Error(`@LazyInject: ${key} is an array or map, pass the element type`);
    }

    const type = isConstructor(service) && isList ? Array.ofType(service) : (service ?? declared);
    const mapFunc = options?.mapFunc;

    const bindings = new WeakMap<object, LazyInjectBinding>();
    const binding = (inject: Class<unknown> | TypedArray<unknown>): IToInject<unknown> => ({
      autoinject: true,
      autoinjectKey: key,
      inject,
      resolveFunc: (_data: unknown, container: IContainer) => new LazyInjectBinding(container, inject),
    });
    const explicit = isConstructor(service) ? service : undefined;

    // The container assigns the binding right after construction, like any autoinject property; the setter keeps it per owner.
    AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>) => {
      const pending = !declared && (!type || !!explicit);
      if (pending) notePendingProperty((target as { constructor: Class<unknown> }).constructor, key);
      descriptor.inject.push(
        !pending
          ? binding(type as Class<unknown>)
          : {
              ...binding(explicit ?? Object),
              pendingType: { property: key, explicit, bind: (resolved, isList) => binding(isList ? Array.ofType(resolved) : resolved) },
            },
      );
    })(target, key, undefined);

    Object.defineProperty(target, key, {
      get(this: object) {
        const bound = bindings.get(this);
        const resolved = bound?.type ?? type;
        if (!resolved) {
          throw new ResolveException(`@LazyInject: no type for ${(target as { constructor: { name: string } }).constructor.name}.${key}: pass it explicitly, enable emitDecoratorMetadata, or resolve the owner in manifest mode`);
        }
        const container = bound?.container ?? DI.RootContainer;
        const value = typeof resolved === 'string' ? container.get(resolved) : container.resolve(resolved as Class<unknown>);
        if (!mapFunc) {
          return value;
        }
        return isPromise(value) ? value.then((v) => toMap(v, mapFunc)) : toMap(value, mapFunc);
      },
      set(this: object, value: unknown) {
        if (!(value instanceof LazyInjectBinding)) {
          throw new TypeError(`@LazyInject property ${key} cannot be assigned`);
        }
        bindings.set(this, value);
      },
    });
  };
}

/** What `design:type` would hold for a property in a build without decorator metadata, for a decorator that needs the type after boot. */
export function declaredPropertyType(owner: Class<unknown>, property: string, container: IContainer = DI.RootContainer): Class<unknown> {
  const type = container.get(PROPERTY_TYPE_RESOLVER)?.typeOf(owner, property, container)?.type;
  if (!type) {
    throw new ResolveException(`cannot read the type of ${owner.name}.${property}: the build emits no decorator metadata; boot from a manifest that records it ( spinajs build )`);
  }
  return type;
}

/**
 * Per child instance injection decorator - object is resolved once per container - child containers have own instances.
 */
export function PerChildInstance() {
  return AddDependency((descriptor: IInjectDescriptor<unknown>) => {
    descriptor.resolver = ResolveType.PerChildContainer;
  });
}

/**
 * NewInstance injection decorator - every time class is injected - its created from scratch
 */
export function NewInstance() {
  return AddDependency((descriptor: IInjectDescriptor<unknown>) => {
    descriptor.resolver = ResolveType.NewInstance;
  });
}

/**
 * If we have multiple registered types at one base type
 * we can resolve only one by default. Per instance means, that
 * we can resolve all types registered at base type once. Limitaiton is
 * that, you should call resolve not on base type, but on target type.
 *
 * In comparison, Singleton flag means that only one instance can be resolved
 * for base class
 */
export function PerInstance() {
  return AddDependency((descriptor: IInjectDescriptor<unknown>) => {
    descriptor.resolver = ResolveType.PerInstance;
  });
}

/**
 *
 * Before resolve, check function on all resolved instances of given type is called with creation options
 * It is used for ensuring that for eg. only one instance of service with provided
 * options is resolved, but allow to create with other option set
 *
 * @returns
 */
export function PerInstanceCheck() {
  return AddDependency((descriptor: IInjectDescriptor<unknown>) => {
    descriptor.resolver = ResolveType.PerInstanceCheck;
  });
}

/**
 * Singleton injection decorator - every time class is resolved - its created only once globally ( even in child DI containers )
 */
export function Singleton() {
  return AddDependency((descriptor: IInjectDescriptor<unknown>) => {
    descriptor.resolver = ResolveType.Singleton;
  });
}
