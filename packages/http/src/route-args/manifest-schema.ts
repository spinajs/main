import { AsyncLocalStorage } from 'node:async_hooks';
import { isTypedArray, type IContainer, type TypedArray } from '@spinajs/di';
import { effectiveManifestOf } from '@spinajs/configuration';
import { InvalidOperation } from '@spinajs/exceptions';
import type { Log } from '@spinajs/log';
import { DECORATED_PARAM_KIND, ownEntries, routeFullPath, servedPath, type ControllerEntry, type Manifest, type ParamEntry, type RouteEntry } from '@spinajs/manifest';
import { manifestValidatorOf, schemaOfClass, type ManifestDataValidator, type ManifestValidationOptions, type ManifestValidator } from '@spinajs/validation';
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

/** Throws `ValidationFailed` for invalid data, else returns the value the argument is built from. */
export type DerivedArgCheck = (data: unknown) => unknown;

export type DerivedArgValidators = ReadonlyMap<IRouteParameter, DerivedArgCheck>;

const NONE: DerivedArgValidators = new Map();
const current = new AsyncLocalStorage<DerivedArgValidators>();

/** Runs a route's argument extraction with its derived validators, for `derivedValidatorOf`. */
export function withDerivedValidators<T>(validators: DerivedArgValidators | undefined, extract: () => Promise<T>): Promise<T> {
  return current.run(validators ?? NONE, extract);
}

/** The validator of `param`'s manifest-derived schema in the route call being extracted. */
export function derivedValidatorOf(param: IRouteParameter): DerivedArgCheck | undefined {
  return current.getStore()?.get(param);
}

/** A class of a controller's lineage, with the file its own decorators ran in, when they did. */
export interface LineageClass {
  name: string;
  file?: string;
}

/** A class and its bases, own first: the manifest lists a route on the class that declares it, and a name may be taken twice. */
export function classLineage(type: unknown, fileOf: (type: object) => string | undefined): LineageClass[] {
  const lineage: LineageClass[] = [];
  for (let current = type; typeof current === 'function' && current.name; current = Object.getPrototypeOf(current) as unknown) {
    lineage.push({ name: current.name, file: fileOf(current) });
  }
  return lineage;
}

const byClassName = new WeakMap<Manifest, Map<string, ControllerEntry[]>>();

/** Controllers, then controller bases, by class name, in manifest order: every route of every controller looks one up. */
function controllersByClassName(manifest: Manifest): Map<string, ControllerEntry[]> {
  let index = byClassName.get(manifest);
  if (!index) {
    index = new Map();
    for (const entry of [...manifest.controllers, ...(manifest.controllerBases ?? [])]) {
      const { className } = entry;
      const named = index.get(className);
      if (named) named.push(entry);
      else index.set(className, [entry]);
    }
    byClassName.set(manifest, index);
  }
  return index;
}

/**
 * The runtime knows a controller by class name, source file, handler and mount path; the class name alone may be taken
 * twice. A subclass serves its bases' routes, and a base lists them under its own mount path, so there only the declared
 * path tells them apart.
 */
export function routeEntryOf(manifest: Manifest, lineage: readonly LineageClass[], route: IRoute, mountPath: string): RouteEntry | undefined {
  const handler = String(route.Method);
  const fullPath = servedPath(routeFullPath(mountPath, route.Path, handler));

  for (const [depth, { name, file }] of lineage.entries()) {
    const served = (r: RouteEntry): boolean => (depth === 0 ? r.fullPath === fullPath : r.path === route.Path);
    const routesOf = (c: ControllerEntry): RouteEntry[] => c.routes.filter((r) => r.handler === handler);
    const named = (controllersByClassName(manifest).get(name) ?? []).filter((c) => routesOf(c).length > 0);
    if (named.length === 0) continue;

    const candidates = ownEntries(named, { file, matches: (c) => routesOf(c).some(served) }, manifest).flatMap(routesOf);
    if (candidates.length === 1) return candidates[0];

    const matching = candidates.filter(served);
    return matching.length === 1 ? matching[0] : undefined;
  }
  return undefined;
}

/** The runtime fills parameter names in later, from the controller source; until then index and kind must do. A decorator the compiler does not know leaves no kind to compare. */
export const describes = (declared: ParamEntry, param: IRouteParameter): boolean => (declared.kind === DECORATED_PARAM_KIND || declared.kind === param.Type) && (!param.Name || declared.name === param.Name);

/**
 * The route's schema, the decorator's, the class `@Schema` and a hydrator each make the derived schema unused at
 * runtime, so it is not even compiled: a broken derived entry must not fail the boot for an argument it never checks.
 */
function derivedUnused(declared: ParamEntry, param: IRouteParameter, route: IRoute): boolean {
  const type: unknown = isTypedArray(param.RuntimeType) ? (param.RuntimeType as TypedArray<unknown>).Type : param.RuntimeType;
  const routeSchema = route.Schema as Record<string, unknown> | null | undefined;
  const hydrated = typeof type === 'function' && Reflect.getMetadata('custom:arg_hydrator', type) !== undefined;
  return !!routeSchema?.[declared.name] || !!param.Schema || schemaOfClass(type) !== undefined || hydrated;
}

interface DerivedCheck {
  id: string;
  name: string;
  options: ManifestValidationOptions;
}

function declaredOnly(data: unknown, names: readonly string[]): unknown {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return data;
  const source = data as Record<string, unknown>;
  return Object.fromEntries(names.filter((name) => Object.hasOwn(source, name)).map((name) => [name, source[name]]));
}

/**
 * A whole body root is open for other readers ( a reauth strategy reads `reauthPassword` off `req.body` ), but a DTO
 * that assigns what it gets, and a model hydrated from it, must not receive undeclared keys: the argument gets a copy
 * with the declared root keys only, `req.body` stays as sent.
 */
function checkOf(validator: ManifestValidator, check: DerivedCheck): DerivedArgCheck {
  const validate: ManifestDataValidator = validator.validator(check.id, check.options);
  const declared = check.options === WHOLE_BODY ? validator.closedRootProperties(check.id) : undefined;
  return (data) => {
    validate(data);
    return declared ? declaredOnly(data, declared) : data;
  };
}

function derivedCheckOf(declared: ParamEntry | undefined, param: IRouteParameter, route: IRoute): DerivedCheck | undefined {
  const kindOptions = DERIVED_KINDS[param.Type];
  const id = declared?.runtimeType.schema;
  if (!kindOptions || !declared || !id || !describes(declared, param) || derivedUnused(declared, param, route)) return undefined;
  return { id, name: declared.name, options: declared.wire?.shape === 'field' ? BODY_FIELD : kindOptions };
}

export interface DerivedValidatorsOptions {
  container: IContainer;
  controller: string;
  lineage: readonly LineageClass[];
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
export function derivedValidatorsOf({ container, controller, lineage, route, mountPath, log }: DerivedValidatorsOptions): DerivedArgValidators | undefined {
  const effective = effectiveManifestOf(container);
  const manifest = effective?.manifest;
  const entry = manifest && routeEntryOf(manifest, lineage, route, mountPath);
  if (!effective || !manifest || !entry) return undefined;

  const validators = new Map<IRouteParameter, DerivedArgCheck>();
  for (const param of route.Parameters.values()) {
    const check = derivedCheckOf(
      entry.params.find((p) => p.index === param.Index),
      param,
      route,
    );
    if (!check) continue;

    try {
      validators.set(param, checkOf(manifestValidatorOf(manifest), check));
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
