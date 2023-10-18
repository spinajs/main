import { DI, Class, TypedArray } from '@spinajs/di';
import { Effect, Option } from 'effect';

export namespace Util {
  export namespace Di {
    export class ResolveException {
      readonly _tag: 'ResolveException';

      constructor(public Reason: Error) {}
    }

    /**
     * Resolves specified type from root container.
     *
     * @param type - class to resolve
     * @param options - optional parameters passed to class constructor
     * @param check - use parent container to check when resolving
     * @throws {@link InvalidArgument} if type is null or undefined
     */
    export function resolve<T>(type: string, options?: unknown[], check?: boolean): Effect.Effect<never, ResolveException, T>;
    export function resolve<T>(type: string, check?: boolean): Effect.Effect<never, ResolveException, T>;
    export function resolve<T>(type: Class<T>, check?: boolean): Effect.Effect<never, ResolveException, T>;
    export function resolve<T>(type: TypedArray<T>, check?: boolean): Effect.Effect<never, ResolveException, T | T[]>;
    export function resolve<T>(type: Class<T>, options?: unknown[] | boolean, check?: boolean): Effect.Effect<never, ResolveException, T>;
    export function resolve<T>(type: TypedArray<T>, options?: unknown[] | boolean, check?: boolean): Effect.Effect<never, ResolveException, T | T[]>;
    export function resolve<T>(type: Class<T> | TypedArray<T> | string, options?: unknown[] | boolean, check?: boolean): Effect.Effect<never, ResolveException, T | T[]> {
      return Effect.tryPromise({
        try: () => DI.RootContainer.resolve<T>(type, options, check) as Promise<T | T[]>,
        catch: (error: Error) => new ResolveException(error),
      });
    }

    /**
     * Gets already resolved service from root container.
     *
     * @param serviceName - name of service to get
     */
    export function get<T>(serviceName: TypedArray<T>): Option.Option<T[]>;
    export function get<T>(serviceName: string | Class<T>): Option.Option<T>;
    export function get<T>(serviceName: string | Class<T> | TypedArray<T>): Option.Option<T[] | T> {
      return Option.fromNullable(DI.RootContainer.get(serviceName));
    }
  }
}
