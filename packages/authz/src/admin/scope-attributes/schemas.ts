import { Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import AjvModule from 'ajv';
import type { ErrorObject, Options, ValidateFunction } from 'ajv';

import { AuthzConfigError } from '../../contracts/errors.js';
import type { ScopeAttributeSchema } from '../../contracts/adapter.js';
import type { ResourceType } from '../../contracts/principal.js';
import { AuthzContributor } from '../../host/contributor.js';
import type { AuthzContribution } from '../../host/contributor.js';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => isObject(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const q = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return Object.prototype.toString.call(v);
  }
};
const describeError = (e: unknown): string => (e instanceof Error ? e.message : q(e));

/**
 * Schemas are JSON schemas for ajv 8 in strict mode: an unknown keyword or any `format` makes them fail to
 * compile (AuthzConfigError), because no formats are registered.
 *
 * Contributes `authz.scopes.attributes` (`{ [scopeType]: { schema, defaults } }`) as scope attribute schemas
 * of every domain, so the engine's defaults and AuthzAdmin's validation read the same schemas. It reads the
 * configuration on every call and never touches AuthzService (it runs during the service's boot).
 */
@Singleton()
@Injectable(AuthzContributor)
export class ConfigScopeAttributeSchemas extends AuthzContributor {
  @Config('authz.scopes.attributes')
  protected Attributes: Readonly<Record<string, { readonly schema: object; readonly defaults?: Readonly<Record<string, unknown>> }>> | null | undefined;

  async contribute(_domain: string): Promise<AuthzContribution> {
    const section = this.Attributes;
    if (section === undefined || section === null) return {};
    // defaults is a schema default; a Configuration that skips the schema can leave it out.
    return { scopeAttributeSchemas: Object.entries(section).map(([scopeType, { schema, defaults = {} }]) => ({ scopeType, schema, defaults })) };
  }
}

/** The scope attribute schemas every AuthzContributor of `container` gives `domain`, by scope type (what the host collects). */
export async function contributedSchemas(container: IContainer, domain: string, where: string): Promise<ReadonlyMap<ResourceType, ScopeAttributeSchema>> {
  const out = new Map<ResourceType, ScopeAttributeSchema>();
  if (!container.hasRegistered(AuthzContributor)) return out;
  for (const contributor of await container.resolve(Array.chainOf(AuthzContributor))) {
    const name = (isObject(contributor) && typeof contributor.constructor === 'function' && contributor.constructor.name) || 'AuthzContributor';
    let contribution: unknown;
    try {
      contribution = await contributor.contribute(domain);
    } catch (e) {
      throw new AuthzConfigError(`${where}: contributor ${q(name)} failed: ${describeError(e)}`, { cause: e });
    }
    if (!isObject(contribution)) throw new AuthzConfigError(`${where}: contributor ${q(name)} returned ${q(contribution)} instead of an object`);
    const list = contribution.scopeAttributeSchemas;
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new AuthzConfigError(`${where}: the scopeAttributeSchemas of contributor ${q(name)} must be an array`);
    for (const s of list as unknown[]) {
      if (!isObject(s) || typeof s.scopeType !== 'string' || s.scopeType === '') throw new AuthzConfigError(`${where}: contributor ${q(name)} gave a scope attribute schema without a scopeType`);
      if (!isObject(s.schema)) throw new AuthzConfigError(`${where}: the scope attribute schema for ${q(s.scopeType)} has no schema object`);
      if (!isPlainObject(s.defaults)) throw new AuthzConfigError(`${where}: the defaults of the scope attribute schema for ${q(s.scopeType)} must be a plain object`);
      if (out.has(s.scopeType)) throw new AuthzConfigError(`${where}: two scope attribute schemas for type ${q(s.scopeType)}`);
      out.set(s.scopeType, s as unknown as ScopeAttributeSchema);
    }
  }
  return out;
}

interface AjvLike {
  compile(schema: object): ValidateFunction;
  removeSchema(schema: object): unknown;
}
type AjvCtor = new (opts: Options) => AjvLike;

// ajv is CommonJS; under ESM its constructor is the default export's `default`.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as unknown as AjvCtor;

let ajv: AjvLike | undefined;
const compiled = new WeakMap<object, ValidateFunction>();

/** The compiled validator of one schema object, compiled once. */
export function schemaValidator(schema: object, scopeType: string): ValidateFunction {
  let fn = compiled.get(schema);
  if (fn) return fn;
  // strictSchema stays on, so a misspelled keyword or a format ajv does not know (none are bundled) fails
  // the compile instead of passing every value; the other strict checks are style and stay quiet.
  ajv ??= new Ajv({ logger: false, allErrors: false, addUsedSchema: false, validateSchema: true });
  try {
    fn = ajv.compile(schema);
  } catch (e) {
    throw new AuthzConfigError(`the scope attribute schema for ${q(scopeType)} does not compile: ${describeError(e)}`, { cause: e });
  } finally {
    // The WeakMap holds the validator; ajv's own cache would keep every schema object alive.
    try {
      ajv.removeSchema(schema);
    } catch {
      // nothing cached
    }
  }
  compiled.set(schema, fn);
  return fn;
}

/** The dot path an ajv error points at, with the property a `required` or `additionalProperties` error names. */
export function errorPath(e: ErrorObject): string {
  const segments =
    e.instancePath === ''
      ? []
      : e.instancePath
          .slice(1)
          .split('/')
          .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const params = e.params as Record<string, unknown>;
  if (e.keyword === 'required' && typeof params.missingProperty === 'string') segments.push(params.missingProperty);
  if (e.keyword === 'additionalProperties' && typeof params.additionalProperty === 'string') segments.push(params.additionalProperty);
  if (e.keyword === 'dependentRequired' && typeof params.missingProperty === 'string') segments.push(params.missingProperty);
  return segments.join('.');
}
