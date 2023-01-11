import { Container } from './container';
import { IBind, IContainer, AsyncService, ResolvableObject } from './interfaces';
import { Class, Factory } from './types';
import { TypedArray } from './array';

/**
 * App main DI container
 */
export const RootContainer: IContainer = new Container();

/***
 * EVENT LISTENER STUFF
 *
 * Allows to use event listener stuff on root container
 */

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

/**
 * Register class/interface to DI root container. If
 * @param type - interface object to register
 * @throws {@link InvalidArgument} if type is null or undefined
 */
export function register<T>(type: Class<T> | Factory<T> | ResolvableObject): IBind {
  return RootContainer.register(type);
}

export function unregister<T>(type: string | Class<T> | Factory<T> | ResolvableObject): void {
  RootContainer.unregister(type);
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
export function resolve<T>(type: Class<T>, check?: boolean): T extends AsyncService ? Promise<T> : T;
export function resolve<T>(type: TypedArray<T>, check?: boolean): T extends AsyncService ? Promise<T[]> : T[];
export function resolve<T>(type: Class<T>, options?: unknown[] | boolean, check?: boolean): T extends AsyncService ? Promise<T> : T;
export function resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): T extends AsyncService ? Promise<T[]> : T[];
export function resolve<T>(type: Class<T> | TypedArray<T> | string, options?: unknown[] | boolean, check?: boolean): Promise<T | T[]> | T | T[] {
  return RootContainer.resolve<T>(type, options, check);
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
export function getRegisteredTypes<T>(type: string | Class<T>): Class<T>[] {
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
