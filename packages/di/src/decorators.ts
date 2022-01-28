import { ResolveType } from './enums';
import { IInjectDescriptor } from './interfaces';
import { DI } from './root';

export const DI_DESCRIPTION_SYMBOL = Symbol.for('DI_INJECTION_DESCRIPTOR');

function AddDependency(
  callback?: (
    descriptor: IInjectDescriptor<any>,
    target: ArrayBuffer,
    propertyKey: string | symbol,
    indexOrDescriptor: number | PropertyDescriptor,
  ) => void,
): any {
  return (target: any, propertyKey: string | symbol, indexOrDescriptor: number | PropertyDescriptor) => {
    let descriptor: IInjectDescriptor<any> = target[DI_DESCRIPTION_SYMBOL];
    if (!descriptor) {
      descriptor = {
        inject: [],
        resolver: ResolveType.Singleton,
      };

      target[DI_DESCRIPTION_SYMBOL] = descriptor;
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
 * @param as register class in DI container as something else.
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
export function Injectable(as?: Class | string) {
  return (target: any) => {
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
export function Inject(...args: (Class | TypedArray<any>)[]) {
  return AddDependency((descriptor: IInjectDescriptor) => {
    for (const a of args) {
      descriptor.inject.push({
        autoinject: false,
        autoinjectKey: '',
        inject: a as any,
      });
    }
  });
}


/**
 * Automatically injects dependency based on reflected property type. Uses experimental typescript reflection api
 * If decorator is applied to array property all registered type instances are injected, otherwise only first / only that exists
 *
 * @param target
 * @param key
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
export function Autoinject(injectType?: Class) {
  return AddDependency((descriptor: IInjectDescriptor, target: any, propertyKey: string) => {
    const type = Reflect.getMetadata('design:type', target, propertyKey);
    const isArray = type.name === 'Array';

    if (type.name === 'Array' && !injectType) {
      throw new Error('you must provide inject type when injecting array');
    }

    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: isArray ? Array.ofType(injectType) : type,
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
export function LazyInject(service: Class | string) {
  return (target?: any, key?: string) => {
    // property getter
    const getter = () => {
      if (typeof service === 'string') {
        return DI.get<any>(service);
      } else {
        return DI.resolve<any>(service);
      }
    };

    // Create new property with getter and setter
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      get: getter,
    });
  };
}

/**
 * Per child instance injection decorator - object is resolved once per container - child containers have own instances.
 */
export function PerChildInstance() {
  return AddDependency((descriptor: IInjectDescriptor) => {
    descriptor.resolver = ResolveType.PerChildContainer;
  });
}

/**
 * NewInstance injection decorator - every time class is injected - its created from scratch
 */
export function NewInstance() {
  return AddDependency((descriptor: IInjectDescriptor) => {
    descriptor.resolver = ResolveType.NewInstance;
  });
}

/**
 * Singleton injection decorator - every time class is resolved - its created only once globally ( even in child DI containers )
 */
export function Singleton() {
  return AddDependency();
}
