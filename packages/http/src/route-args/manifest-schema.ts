import { AsyncLocalStorage } from 'node:async_hooks';
import { TypedArray, type IContainer } from '@spinajs/di';
import { effectiveManifestOf } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log';
import { routeFullPath, servedPath, type Manifest, type ParamEntry, type RouteEntry } from '@spinajs/manifest';
import { manifestValidatorOf, schemaOfClass, type ManifestDataValidator, type ManifestValidationOptions } from '@spinajs/validation';
import { ParameterType, type IRoute, type IRouteParameter } from '../interfaces.js';

const FROM_STRING: ManifestValidationOptions = { coerce: true };
// A whole query, path, header object or body also holds keys other readers take: other arguments, a reauth strategy's
// `reauthPassword`. Its root accepts them; nested objects and single fields stay closed.
const WHOLE_FROM_STRINGS: ManifestValidationOptions = { coerce: true, openRoot: true };
const WHOLE_BODY: ManifestValidationOptions = { coerce: false, openRoot: true };
const BODY_FIELD: ManifestValidationOptions = { coerce: false };

/** The argument kinds checked against their derived schema; other kinds ( models, files, custom args ) never are. */
const DERIVED_KINDS: Partial<Record<string, ManifestValidationOptions>> = {
  [ParameterType.FromBody]: WHOLE_BODY,
  [ParameterType.BodyField]: WHOLE_BODY,
  [ParameterType.FromQuery]: FROM_STRING,
  [ParameterType.FromParams]: FROM_STRING,
  [ParameterType.FromHeader]: FROM_STRING,
  [ParameterType.FromCookie]: FROM_STRING,
  [ParameterType.QueryField]: WHOLE_FROM_STRINGS,
  [ParameterType.ParamField]: WHOLE_FROM_STRINGS,
  [ParameterType.Headers]: WHOLE_FROM_STRINGS,
};

export type DerivedArgValidators = ReadonlyMap<IRouteParameter, ManifestDataValidator>;

const NONE: DerivedArgValidators = new Map();
const current = new AsyncLocalStorage<DerivedArgValidators>();

/** Runs a route's argument extraction with its derived validators, for `derivedValidatorOf`. */
export function withDerivedValidators<T>(validators: DerivedArgValidators | undefined, extract: () => Promise<T>): Promise<T> {
  return current.run(validators ?? NONE, extract);
}

/** The validator of `param`'s manifest-derived schema in the route call being extracted. */
export function derivedValidatorOf(param: IRouteParameter): ManifestDataValidator | undefined {
  return current.getStore()?.get(param);
}

/** The runtime knows a controller by class name, handler and mount path; the class name alone may be taken twice. */
function routeEntryOf(manifest: Manifest, controller: string, route: IRoute, mountPath: string): RouteEntry | undefined {
  const handler = String(route.Method);
  const candidates = manifest.controllers.filter((c) => c.className === controller).flatMap((c) => c.routes.filter((r) => r.handler === handler));
  if (candidates.length <= 1) return candidates[0];

  const fullPath = servedPath(routeFullPath(mountPath, route.Path, handler));
  const matching = candidates.filter((r) => r.fullPath === fullPath);
  return matching.length === 1 ? matching[0] : undefined;
}

// The runtime fills parameter names in later, from the controller source; until then index and kind must do.
const describes = (declared: ParamEntry, param: IRouteParameter): boolean => declared.kind === param.Type && (!param.Name || declared.name === param.Name);

/** The decorator's schema or the class `@Schema` wins at runtime, so the derived schema is not even compiled for it. */
function hasExplicitSchema(param: IRouteParameter): boolean {
  const type: unknown = param.RuntimeType instanceof TypedArray ? (param.RuntimeType as TypedArray<unknown>).Type : param.RuntimeType;
  return !!param.Schema || schemaOfClass(type) !== undefined;
}

interface DerivedCheck {
  id: string;
  name: string;
  options: ManifestValidationOptions;
}

function derivedCheckOf(declared: ParamEntry | undefined, param: IRouteParameter): DerivedCheck | undefined {
  const kindOptions = DERIVED_KINDS[param.Type];
  const id = declared?.runtimeType.schema;
  if (!kindOptions || !declared || !id || !describes(declared, param) || hasExplicitSchema(param)) return undefined;
  return { id, name: declared.name, options: declared.wire?.shape === 'field' ? BODY_FIELD : kindOptions };
}

export interface DerivedValidatorsOptions {
  container: IContainer;
  controller: string;
  route: IRoute;
  mountPath: string;
  log: Log;
}

/**
 * Compiles the derived schema of every argument of `route` that the manifest describes, once, when the controller
 * registers its routes. Nothing without an effective manifest ( `off`, or `prefer` without one ). A schema that cannot
 * compile fails the boot in `require` and leaves that argument unchecked, with a warning, in `prefer`. Arguments whose
 * index, kind or name disagree with the manifest ( a stale build ) are not checked.
 */
export function derivedValidatorsOf({ container, controller, route, mountPath, log }: DerivedValidatorsOptions): DerivedArgValidators | undefined {
  const effective = effectiveManifestOf(container);
  const manifest = effective?.manifest;
  const entry = manifest && routeEntryOf(manifest, controller, route, mountPath);
  if (!effective || !manifest || !entry) return undefined;

  const validators = new Map<IRouteParameter, ManifestDataValidator>();
  for (const param of route.Parameters.values()) {
    const check = derivedCheckOf(
      entry.params.find((p) => p.index === param.Index),
      param,
    );
    if (!check) continue;

    try {
      validators.set(param, manifestValidatorOf(manifest).validator(check.id, check.options));
    } catch (err) {
      const problem = `argument ${check.name} of ${controller}::${String(route.Method)} cannot be validated: ${(err as Error).message}`;
      if (effective.settings.mode === 'require') {
        throw new InvalidOperation(problem);
      }
      log.warn({ problem }, 'Manifest request validation: ${problem}');
    }
  }
  return validators;
}
