import { ResolveType } from './enums.js';
import { IAutoinjectOptions, IInjectDescriptor } from './interfaces.js';
import { Class } from './types.js';
import { TypedArray } from './array.js';
import * as DI from './root.js';
import { isConstructor, isTypedArray } from './helpers.js';

export const DI_DESCRIPTION_SYMBOL = '__DI_INJECTION_DESCRIPTOR__';

export function AddDependencyForProperty(callback?: (descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    let descriptor = Reflect.getOwnMetadata(DI_DESCRIPTION_SYMBOL, target.constructor) as IInjectDescriptor<unknown>;
    if (!descriptor) {
      descriptor = {
        inject: [],
        resolver: ResolveType.Singleton,
      };

      Reflect.defineMetadata(DI_DESCRIPTION_SYMBOL, descriptor, target.constructor);
    }

    if (callback) {
      callback(descriptor, target, propertyKey, indexOrDescriptor);
    }
  };
}

export function AddDependency(callback?: (descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => void): any {
  return (target: Class<unknown>, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    let descriptor = Reflect.getOwnMetadata(DI_DESCRIPTION_SYMBOL, target) as IInjectDescriptor<unknown>;
    if (!descriptor) {
      descriptor = {
        inject: [],
        resolver: ResolveType.Singleton,
      };

      Reflect.defineMetadata(DI_DESCRIPTION_SYMBOL, descriptor, target);
    }

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
    } else {
      DI.register(target).asSelf();
    }
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
            return i.inject === a;
          }
        })
      ) {
        descriptor.inject.push({
          autoinject: false,
          autoinjectKey: '',
          inject: a,
          mapFunc: null,
        });
      }
    }
  });
}

/**
 * Automatically injects dependency based on reflected property type. Uses experimental typescript reflection api
 * If decorator is applied to array property all registered type instances are injected, otherwise only first / only that exists
 *
 * @param injectType - when injecting array of some type, type must be explicitly provided. Typescript reflection cant reflect declared array types
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
export function Autoinject<T>(typeOrOptions?: Class<T> | IAutoinjectOptions, options?: IAutoinjectOptions) {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, target: Class<unknown>, propertyKey: string) => {
    let type = Reflect.getMetadata('design:type', target, propertyKey) as Class<unknown>;
    const isArray = type.name === 'Array' || type.name === 'Map';
    let opt = options;

    if (isConstructor(typeOrOptions)) {
      if (isArray && !typeOrOptions) {
        throw new Error('you must provide inject type when injecting array');
      }
      type = typeOrOptions;
    } else {
      opt = typeOrOptions;
    }

    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: isArray ? Array.ofType(typeOrOptions as Class<T>) : type,
      mapFunc: opt?.mapFunc,
      options: opt?.options,
    });
  });
}

/**
 * Lazy injects service to object. Use only with class properties
 *
 * @param service - class or name of service to inject
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
export function LazyInject(service?: Class<any> | string) {
  return (target?: any, key?: string) => {
    const type = Reflect.getMetadata('design:type', target, key) as Class<unknown>;

    // property getter
    const getter = () => {
      if (!service) {
        return DI.resolve(type);
      } else {
        if (typeof service === 'string') {
          return DI.get(service);
        } else {
          return DI.resolve(service);
        }
      }
    };

    // Create new property with getter and setter
    Object.defineProperty(target, key, {
      get: getter,
    });
  };
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
  return AddDependency();
}
