import type { IContainer } from '@spinajs/di';
import { effectiveManifestOf } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log';
import { resolveTypeRef } from '@spinajs/manifest';
import { routeParamSchemaFor } from './decorators.js';
import type { IRoute } from './interfaces.js';
import { routeEntryOf } from './route-args/manifest-schema.js';

export interface ManifestRuntimeTypesOptions {
  container: IContainer;
  controller: string;
  routes: Iterable<IRoute>;
  /** Read only for a route with an untyped argument: a `@BasePath({ config })` controller reads its configuration. */
  mountPath: () => string;
  log: Log;
}

/**
 * A build without decorator metadata leaves `RuntimeType` undefined; the manifest names each argument's type
 * ( `TypeRef.ref` ). Runs before the routes are built, so validation and hydration see what the metadata would have
 * given. Nothing happens without an effective manifest. An argument it cannot type fails the boot in `require` and
 * stays untyped, with a warning, in `prefer`.
 */
export async function runtimeTypesFromManifest({ container, controller, routes, mountPath, log }: ManifestRuntimeTypesOptions): Promise<void> {
  const effective = effectiveManifestOf(container);
  const manifest = effective?.manifest;
  if (!effective || !manifest) return;

  for (const route of routes) {
    const untyped = [...route.Parameters.values()].filter((p) => p.RuntimeType === undefined);
    if (untyped.length === 0) continue;

    const entry = routeEntryOf(manifest, controller, route, mountPath());
    for (const param of untyped) {
      const declared = entry?.params.find((p) => p.index === param.Index);
      try {
        if (!declared?.runtimeType.ref) {
          throw new InvalidOperation('the manifest records no runtime type for it, run spinajs build');
        }
        param.RuntimeType = await resolveTypeRef(declared.runtimeType.ref, manifest);
        param.RouteParamSchema = routeParamSchemaFor(param.RuntimeType);
      } catch (err) {
        const problem = `argument ${declared?.name ?? `#${param.Index}`} of ${controller}::${String(route.Method)} has no runtime type and the build emits no decorator metadata: ${(err as Error).message}`;
        if (effective.settings.mode === 'require') {
          throw new InvalidOperation(problem);
        }
        log.warn({ problem }, 'Manifest runtime types: ${problem}');
      }
    }
  }
}
