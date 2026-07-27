import { Perf, IMeasureOpts } from "@spinajs/log-common";

/**
 * Method decorator that times the wrapped method via {@link Perf.measure}. Name
 * defaults to `${ClassName}.${method}`. Works for sync and async methods ( the
 * facade awaits a returned thenable ). Uses the same legacy-decorator signature
 * as the rest of the framework ( `experimentalDecorators` ).
 */
export function Measure(name?: string, opts?: IMeasureOpts) {
  return function (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor): PropertyDescriptor {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    const metricName = name ?? `${(target as { constructor: { name: string } }).constructor.name}.${String(propertyKey)}`;
    descriptor.value = function (this: unknown, ...args: unknown[]): unknown {
      return Perf.measure(metricName, () => original.apply(this, args), opts);
    };
    return descriptor;
  };
}
