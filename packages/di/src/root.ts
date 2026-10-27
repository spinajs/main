import { pathToFileURL } from 'node:url';
import { Container } from './container.js';
import { IBind, IContainer, IDisposeOptions, ResolvableObject, ResolveChainResult } from './interfaces.js';
import { Class, InferClass, InferTypedArray, ResolveResult, ResolveArrayResult, Factory } from './types.js';
import { ChainArray, TypedArray } from './array.js';

/**
 * App main DI container
 */
export const RootContainer: IContainer = new Container();

/***
 * EVENT LISTENER STUFF
 *
 * Allows to use event listener stuff on root container
 */

let esmDeprecationEmitted = false;

/**
 * @deprecated 4.0: the loader is ESM-only; this call is a no-op kept so 3.x call sites keep
 * compiling. Removed in 5.0.
 */
export function setESMModuleSupport() {
  if (!esmDeprecationEmitted) {
    esmDeprecationEmitted = true;
    process.emitWarning('DI.setESMModuleSupport() is a no-op since @spinajs/di 4.0 and will be removed in 5.0.', { type: 'DeprecationWarning', code: 'SPINAJS_ESM_MODE' });
  }
  RootContainer.register({ mjs: true }).asValue('__esmMode__', true);
}

export function on(event: string, listener: (...args: unknown[]) => void) {
  return RootContainer.on(event, listener);
}
export function addListener(event: string | symbol, listener: (...args: unknown[]) => void) {
  return RootContainer.addListener(event, listener);
}
export function once(event: string | symbol, listener: (...args: unknown[]) => void) {
  return RootContainer.once(event, listener);
}
export function removeListener(event: string | symbol, listener: (...args: unknown[]) => void) {
  return RootContainer.removeListener(event, listener);
}
export function off(event: string | symbol, listener: (...args: unknown[]) => void) {
  return RootContainer.off(event, listener);
}
export function removeAllListeners(event?: string | symbol) {
  return RootContainer.removeAllListeners(event);
}
export function setMaxListeners(n: number) {
  return RootContainer.setMaxListeners(n);
}
export function getMaxListeners() {
  return RootContainer.getMaxListeners();
}
export function listeners(event: string | symbol) {
  return RootContainer.listeners(event);
}
export function rawListeners(event: string | symbol) {
  return RootContainer.rawListeners(event);
}
export function emit(event: string | symbol, ...args: unknown[]) {
  return RootContainer.emit(event, ...args);
}
export function listenerCount(type: string | symbol) {
  return RootContainer.listenerCount(type);
}
export function prependListener(event: string | symbol, listener: (...args: unknown[]) => void) {
  return RootContainer.prependListener(event, listener);
}
export function prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void) {
  return RootContainer.prependOnceListener(event, listener);
}
export function eventNames(): (string | symbol)[] {
  return RootContainer.eventNames();
}

/**
 * ===========================================================================
 */

/**
 * Clears root container registry and cache.
 */
export function clear() {
  RootContainer.clearCache();
  RootContainer.clearRegistry();
}

/**
 * Clears out root registry ( registered types in root container )
 */
export function clearRegistry() {
  RootContainer.clearRegistry();
}

/**
 * Cleart ous root cache ( all resolved types )
 */
export function clearCache() {
  RootContainer.clearCache();
}

export async function dispose(options?: IDisposeOptions) {
  await RootContainer.dispose(options);
}

/**
 * Register class/interface to DI root container. If
 * @param type - interface object to register
 * @throws {@link InvalidArgument} if type is null or undefined
 */
export function register<T>(type: Class<T> | Factory<T> | ResolvableObject): IBind {
  return RootContainer.register(type);
}

export function unregister<T>(type: string | Class<T> | Factory<T> | ResolvableObject): void;
export function unregister<T>(type: string | Class<T>, implementation: Class<unknown> | Factory<unknown> | ResolvableObject): void;
export function unregister<T>(type: string | Class<T> | Factory<T> | ResolvableObject, implementation?: Class<unknown> | Factory<unknown> | ResolvableObject): void {
  if (implementation === undefined) {
    RootContainer.unregister(type);
  } else {
    RootContainer.unregister(type as string | Class<T>, implementation);
  }
}

export function uncache<T>(type: string | Class<T> | TypedArray<T>, parent?: boolean): void {
  RootContainer.uncache(type, parent);
}

/**
 * Resolves specified type from root container.
 *
 * @param type - class to resolve
 * @param options - optional parameters passed to class constructor
 * @param check - use parent container to check when resolving
 * @throws {@link InvalidArgument} if type is null or undefined
 */
export function resolve<T>(type: string, options?: unknown[], check?: boolean): T;
export function resolve<T>(type: string, check?: boolean): T;
export function resolve<T>(type: Class<T>, check?: boolean): ResolveResult<T>;
export function resolve<T>(type: Class<T>, options?: unknown[] | boolean, check?: boolean): ResolveResult<T>;
export function resolve<T>(type: ChainArray<T>, check?: boolean): ResolveChainResult<T>;
export function resolve<T>(type: ChainArray<T>, options?: unknown[] | boolean, check?: boolean): ResolveChainResult<T>;
export function resolve<T>(type: TypedArray<T>, check?: boolean): ResolveArrayResult<T>;
export function resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): ResolveArrayResult<T>;
export function resolve<T extends Class<any>>(type: T, check?: boolean): ResolveResult<InferClass<T>>;
export function resolve<T extends TypedArray<any>>(type: T, check?: boolean): ResolveArrayResult<InferTypedArray<T>>;
export function resolve<T extends Class<any>>(type: T, options?: unknown[] | boolean, check?: boolean): ResolveResult<InferClass<T>>;
export function resolve<T extends TypedArray<any>>(type: T, options?: unknown[] | boolean, check?: boolean): ResolveArrayResult<InferTypedArray<T>>;
export function resolve(type: Class<any> | TypedArray<any> | string, options?: unknown[] | boolean, check?: boolean): unknown {
  return RootContainer.resolve(type as any, options, check);
}

/**
 * Gets already resolved service from root container.
 *
 * @param serviceName - name of service to get
 */
export function get<T>(serviceName: TypedArray<T>): T[] | null;
export function get<T>(serviceName: string | Class<T>): T | null;
export function get<T>(serviceName: string | Class<T> | TypedArray<T>): T | T[] | null {
  return RootContainer.get(serviceName) as T;
}

/**
 *
 * Returns list of types registered at given type, eg. all types/services registered under BaseService
 *
 * @param type - base type to check
 */
export function getRegisteredTypes<T>(type: TypedArray<T>): Array<Class<unknown> | Factory<unknown>>;
export function getRegisteredTypes<T>(type: string | Class<T>): Class<T>[];
export function getRegisteredTypes<T>(type: string | Class<T> | TypedArray<T>): Array<Class<unknown> | Factory<unknown>> {
  return RootContainer.getRegisteredTypes(type);
}

/**
 * Checks if service is already resolved and exists in container cache.
 * NOTE: check is only valid for classes that are singletons.
 *
 * @param service - service name or class to check
 */
export function has<T>(service: string | Class<T>): boolean {
  return RootContainer.isResolved(service);
}

/**
 * Checks if service is registered in container.
 *
 * @param service - service class object to check
 */
export function check<T>(service: Class<T> | string): boolean {
  return RootContainer.hasRegistered(service);
}

/**
 * Checks if something other than `type` itself is registered under `type` in the root container,
 * e.g. an implementation of an abstract contract.
 */
export function hasImplementation<T>(type: Class<T> | string): boolean {
  return RootContainer.hasImplementation(type);
}

/**
 * Checks if specific service is registered in container.
 * Eg. we can have multiple drivers registered for queue connections with different protocol implementations
 * and we want to check if specific driver is registered
 *
 * @param source - source class to check ( eg. base class )
 * @param type - specific type to check eg. base class implementation
 */
export function checkType<T>(source: Class<any> | string | TypedArray<any>, type: Class<T> | string | TypedArray<T> | object): boolean {
  return RootContainer.hasRegisteredType(source, type);
}

/**
 * Creates child DI container.
 *
 */
export function child(): IContainer {
  return RootContainer.child();
}

/**
 * Injectable module loader seam. When a service is registered under
 * `__module_loader__` it takes over dynamic module loading entirely. This is
 * the browser / bundler escape hatch: no `require`, no bare dynamic import of a
 * file path — a DI-provided loader decides how ( and whether ) to load a module.
 */
export interface IModuleLoader {
  load(module: string): Promise<unknown>;
}

export async function __spinajs_require__(module: string): Promise<unknown> {
  // DI seam first: if an explicit module loader is registered, delegate to it.
  const loader = RootContainer.get<IModuleLoader>('__module_loader__');
  if (loader) {
    return loader.load(module);
  }

  // @vite-ignore keeps bundlers from trying to statically analyse / bundle
  // a runtime file path ( never reached in the browser — no file sources ).
  const specifier = module.startsWith('file://') ? module : pathToFileURL(module).href;
  const result = (await import(/* @vite-ignore */ specifier)) as { default?: unknown };
  return result.default ?? result;
}
