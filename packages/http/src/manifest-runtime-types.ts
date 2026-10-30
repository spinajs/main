import type { IContainer } from '@spinajs/di';
import { effectiveManifestOf, type EffectiveManifest } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log';
import { resolveTypeRef, type ParamEntry } from '@spinajs/manifest';
import { routeParamSchemaFor } from './decorators.js';
import type { IRoute, IRouteParameter } from './interfaces.js';
import { describes, routeEntryOf } from './route-args/manifest-schema.js';

type Routes = Map<string | symbol, IRoute>;

export interface ManifestRuntimeTypesOptions {
  container: IContainer;
  controller: string;
  /** The controller's class names, its own first: a route may be inherited. */
  lineage: readonly string[];
  routes: Routes;
  /** Read only for a route with an untyped argument: a `@BasePath({ config })` controller reads its configuration. */
  mountPath: () => string;
  log: Log;
}

const isUntyped = (route: IRoute): boolean => [...route.Parameters.values()].some((p) => p.RuntimeType === undefined);

async function typeOf(param: IRouteParameter, declared: ParamEntry | undefined, effective: EffectiveManifest): Promise<unknown> {
  if (!declared?.runtimeType.ref) {
    throw new InvalidOperation('the manifest records no runtime type for it, run spinajs build');
  }
  if (!describes(declared, param)) {
    throw new InvalidOperation('the manifest describes another argument at this position, run spinajs build');
  }
  return resolveTypeRef(declared.runtimeType.ref, effective.manifest!);
}

async function typedParameters(route: IRoute, effective: EffectiveManifest, options: ManifestRuntimeTypesOptions): Promise<IRoute['Parameters']> {
  const { controller, lineage, mountPath, log } = options;
  const entry = routeEntryOf(effective.manifest!, lineage, route, mountPath());
  const parameters: IRoute['Parameters'] = new Map(route.Parameters);

  for (const param of route.Parameters.values()) {
    if (param.RuntimeType !== undefined) continue;

    const declared = entry?.params.find((p) => p.index === param.Index);
    try {
      const RuntimeType = await typeOf(param, declared, effective);
      parameters.set(param.Index, { ...param, RuntimeType, RouteParamSchema: routeParamSchemaFor(RuntimeType) });
    } catch (err) {
      const problem = `argument ${declared?.name ?? `#${param.Index}`} of ${controller}::${String(route.Method)} has no runtime type: ${(err as Error).message}`;
      if (effective.settings.mode === 'require') {
        throw new InvalidOperation(problem);
      }
      log.error(problem);
    }
  }
  return parameters;
}

function reportUntyped(route: IRoute, { controller, log }: ManifestRuntimeTypesOptions): void {
  for (const param of route.Parameters.values()) {
    if (param.RuntimeType === undefined) {
      log.error(`argument #${param.Index} of ${controller}::${String(route.Method)} has no runtime type: the build emits no decorator metadata and no manifest answers for it, requests that read it will fail. Set system.manifest.mode and run spinajs build, or enable emitDecoratorMetadata`);
    }
  }
}

/**
 * A build without decorator metadata leaves `RuntimeType` undefined; the manifest names each argument's type
 * ( `TypeRef.ref` ). The class descriptor is shared by every boot in the process and by subclasses, so a route that
 * needs a type gets a copy: the rest of the boot and the requests read the map this returns, which is `routes` itself
 * when nothing was missing. An argument the manifest cannot type fails the boot in `require` and stays untyped, with a
 * logged error, otherwise.
 */
export async function routesWithRuntimeTypes(options: ManifestRuntimeTypesOptions): Promise<Routes> {
  const untyped = [...options.routes].filter(([, route]) => isUntyped(route));
  if (untyped.length === 0) return options.routes;

  const effective = effectiveManifestOf(options.container);
  const typed: Routes = new Map(options.routes);
  for (const [member, route] of untyped) {
    if (effective?.manifest) {
      typed.set(member, { ...route, Parameters: await typedParameters(route, effective, options) });
    } else {
      reportUntyped(route, options);
    }
  }
  return typed;
}
