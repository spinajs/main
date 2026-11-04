import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { Autoinject, Container, Injectable, type IContainer } from '@spinajs/di';
import { addKeywordPluginsOnUse, effectiveManifestOf } from '@spinajs/configuration';
import type { Manifest } from '@spinajs/manifest';
import { ValidationFailed, type IValidationError } from './exceptions/index.js';
import { SchemaSource, type ISchema, type ISchemaObject } from './types.js';
import { addSafeKeywords, dropNonFiniteDuplicates, nonFiniteErrors } from './keywords.js';

type Json = Record<string, unknown>;

/** Manifest ids are relative ('spinajs/pkg/Name'); Ajv would resolve a relative $ref against the $id of the schema holding it. */
const BASE = 'https://manifest.spinajs.invalid/';

/** The key a manifest schema is registered under, in `DataValidator` and in the manifest validators. */
export const manifestSchemaKey = (id: string): string => `${BASE}${id}`;
const manifestId = (key: string): string => (key.startsWith(BASE) ? key.slice(BASE.length) : key);

// Keys of these hold schemas by name, so a property called `x-foo` or `$ref` is data, not a keyword.
const NAMED_SCHEMAS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPartial = (schema: unknown): boolean => isObject(schema) && schema['x-explicit'] === 'partial';
// An `allOf` node with its own `additionalProperties: false` accepts only its own `properties`, as a prepared intersection does.
const isClosedObject = (schema: Json): boolean => schema.additionalProperties === false && isObject(schema.properties) && !schema.anyOf && !schema.oneOf;

function opened(schema: Json): Json {
  const copy = { ...schema };
  delete copy.$id;
  delete copy.additionalProperties;
  return copy;
}

/**
 * Turns manifest schemas into what Ajv validates requests with:
 * - `x-*` keywords are dropped and `$ref`s to manifest ids made absolute;
 * - an `x-explicit: 'partial'` schema accepts anything: the analyzer could not read the explicit `@Schema`, and the
 *   runtime one, which validates that class on its own, may accept more than the class shape;
 * - the compiler derives `A & B` as an `allOf` of two closed objects, which no input satisfies. Each closed member is
 *   opened and the intersection closed over the union of their property names; with an open member it stays open.
 */
const PROTO = '__proto__';

/**
 * A schema that names a property `__proto__`, in `properties`, `required`, `dependencies`, `anyRequired`, `oneRequired`
 * or a `deepRequired` pointer. Ajv skips that name: an open object accepts any `__proto__` value and
 * `required: ['__proto__']` passes without the key, so the rule would hold nowhere. The schema is refused instead.
 */
export class UnenforceableSchema extends Error {
  constructor(public readonly schemaId: string, message: string) {
    super(message);
  }
}

const namesProto = (list: unknown): boolean => Array.isArray(list) && list.includes(PROTO);
// A JSON pointer segment unescapes `~1` and `~0`; `/a~1__proto__` names `a/__proto__`, not `__proto__`.
const pointsAtProto = (pointer: unknown): boolean => typeof pointer === 'string' && pointer.split('/').some((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~') === PROTO);

const declaresProto = (schema: Json): boolean =>
  (isObject(schema.properties) && Object.hasOwn(schema.properties, PROTO)) ||
  namesProto(schema.required) ||
  (isObject(schema.dependencies) && (Object.hasOwn(schema.dependencies, PROTO) || Object.values(schema.dependencies).some(namesProto))) ||
  namesProto(schema.anyRequired) ||
  namesProto(schema.oneRequired) ||
  (Array.isArray(schema.deepRequired) && schema.deepRequired.some(pointsAtProto));

class ManifestSchemaPreparer {
  protected prepared = new Map<string, Json>();
  protected inProgress = new Set<string>();

  constructor(protected schemas: Record<string, unknown>) {}

  public schema(id: string): Json {
    let result = this.prepared.get(id);
    if (!result) {
      const raw = this.schemas[id];
      this.inProgress.add(id);
      try {
        result = isPartial(raw) ? {} : (this.prepare(raw) as Json);
      } catch (error) {
        if (!(error instanceof UnenforceableSchema) || error.schemaId === id) throw error;
        throw new UnenforceableSchema(id, `schema ${id} references ${error.schemaId}, which declares a property named ${PROTO} that cannot be validated`);
      } finally {
        this.inProgress.delete(id);
      }
      if (!isPartial(raw) && containsProto(raw)) {
        throw new UnenforceableSchema(id, `schema ${id} declares a property named ${PROTO}, which cannot be validated: Ajv skips that name`);
      }
      this.prepared.set(id, result);
    }
    return result;
  }

  protected prepare(value: unknown, named = false): unknown {
    if (Array.isArray(value)) return value.map((item) => this.prepare(item));
    if (!isObject(value)) return value;

    const copy: Json = {};
    for (const [key, child] of Object.entries(value)) {
      if (!named && key.startsWith('x-')) continue;
      const prepared = !named && key === '$ref' && typeof child === 'string' ? this.ref(child) : this.prepare(child, !named && NAMED_SCHEMAS.has(key));
      // Not `copy[key] =`: for a property named `__proto__` that sets the prototype and drops the property.
      Object.defineProperty(copy, key, { value: prepared, enumerable: true, writable: true, configurable: true });
    }
    return !named && Array.isArray(copy.allOf) ? this.intersection(copy, copy.allOf) : copy;
  }

  protected ref(ref: string): string {
    return ref.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(ref) ? ref : manifestSchemaKey(ref);
  }

  /** What an `allOf` member validates against: the schema it references, or itself. */
  protected target(member: unknown): Json | undefined {
    if (!isObject(member)) return undefined;
    if (typeof member.$ref !== 'string' || Object.keys(member).length !== 1) return member;

    const id = manifestId(member.$ref);
    if (!Object.hasOwn(this.schemas, id) || this.inProgress.has(id)) return undefined;
    return this.schema(id);
  }

  protected intersection(node: Json, members: unknown[]): Json {
    const names = new Set<string>();
    let allClosed = true;

    const allOf = members.map((member) => {
      const target = this.target(member);
      if (!target || !isClosedObject(target)) {
        allClosed = false;
        return member;
      }
      Object.keys(target.properties as Json).forEach((name) => names.add(name));
      return opened(target);
    });

    if (!allClosed) {
      return { ...node, allOf };
    }
    const properties = { ...(isObject(node.properties) ? node.properties : {}), ...Object.fromEntries([...names].map((name) => [name, true])) };
    return { ...node, allOf, properties, additionalProperties: false };
  }
}

/** Whether `schema`, or a subschema of it, declares a property named `__proto__`. */
function containsProto(value: unknown, named = false): boolean {
  if (Array.isArray(value)) return value.some((item) => containsProto(item));
  if (!isObject(value)) return false;
  if (!named && declaresProto(value)) return true;
  return Object.entries(value).some(([key, child]) => (named || !key.startsWith('x-')) && containsProto(child, !named && NAMED_SCHEMAS.has(key)));
}

/**
 * Every manifest schema, ready for Ajv, under its {@link manifestSchemaKey}. An {@link UnenforceableSchema} is left
 * out, and its message put in `unenforceable` under its id.
 */
export function prepareManifestSchemas(manifest: Manifest, unenforceable?: Map<string, string>): ISchemaObject[] {
  const preparer = new ManifestSchemaPreparer(manifest.schemas);
  return Object.keys(manifest.schemas).flatMap((id) => {
    try {
      return [{ ...preparer.schema(id), $id: manifestSchemaKey(id) }];
    } catch (error) {
      if (!(error instanceof UnenforceableSchema)) throw error;
      unenforceable?.set(id, error.message);
      return [];
    }
  });
}

export interface ManifestValidationOptions {
  /**
   * Coerce values to the schema types, as Ajv `coerceTypes: 'array'` does: for query, path, header and cookie values,
   * which arrive as strings. Never for a JSON body, whose types are the client's.
   */
  coerce: boolean;
  /** Accept root properties the schema does not declare: a whole query or header object holds keys of other arguments too. */
  openRoot?: boolean;
}

/** Throws `ValidationFailed` for invalid data; may coerce `data` in place. */
export type ManifestDataValidator = (data: unknown) => void;

// The CJS plugin is callable at runtime, while its types describe the module namespace.
const withFormats = addFormats as unknown as (ajv: Ajv) => Ajv;

const invalidSchema = (id: string): Error => new Error(`schema ${id} is not a valid JSON Schema`);

/** Validators for one manifest's schemas; each schema compiles once per option set. */
export class ManifestValidator {
  protected instances = new Map<boolean, Ajv>();
  protected validators = new Map<string, ManifestDataValidator>();
  protected schemas: Map<string, ISchemaObject>;
  /** Keys of the schemas Ajv refused; each Ajv instance refuses the same ones. */
  protected refused = new Set<string>();

  /** The ids of the manifest schemas left out as {@link UnenforceableSchema}, with the reason. */
  protected unenforceable = new Map<string, string>();

  constructor(protected manifest: Manifest) {
    this.schemas = new Map(prepareManifestSchemas(manifest, this.unenforceable).map((schema) => [schema.$id, schema]));
  }

  /** @throws Error when `id` is not in the manifest or its schema cannot be compiled */
  public validator(id: string, options: ManifestValidationOptions): ManifestDataValidator {
    const cacheKey = `${options.coerce ? 'c' : 's'}${options.openRoot ? 'o' : 'r'}:${id}`;
    let validator = this.validators.get(cacheKey);
    if (!validator) {
      validator = this.compile(id, options);
      this.validators.set(cacheKey, validator);
    }
    return validator;
  }

  /**
   * The root property names of `id` when its root accepts no other keys: a closed object, or an intersection of closed
   * ones. Undefined for an open, union, partial or `$ref` root, whose accepted keys are not a known list.
   */
  public closedRootProperties(id: string): readonly string[] | undefined {
    const schema = this.schemas.get(manifestSchemaKey(id));
    if (!schema || schema.additionalProperties !== false || !isObject(schema.properties) || schema.patternProperties !== undefined) {
      return undefined;
    }
    return Object.keys(schema.properties);
  }

  protected compile(id: string, options: ManifestValidationOptions): ManifestDataValidator {
    const schema = this.schemas.get(manifestSchemaKey(id));
    const unenforceable = this.unenforceable.get(id);
    if (unenforceable !== undefined) {
      throw new Error(unenforceable);
    }
    if (!schema) {
      throw new Error(`schema ${id} is not in the manifest`);
    }

    const ajv = this.ajv(options.coerce);
    if (this.refused.has(schema.$id)) {
      throw invalidSchema(id);
    }
    let validate: ValidateFunction | undefined;
    try {
      validate = options.openRoot && schema.additionalProperties === false ? ajv.compile(opened(schema)) : ajv.getSchema(schema.$id);
    } catch (error) {
      throw this.compileFailure(id, error);
    }
    if (!validate) {
      throw invalidSchema(id);
    }

    const compiled = validate;
    return (data) => {
      if (!compiled(data)) {
        throw new ValidationFailed('validation error', dropNonFiniteDuplicates((compiled.errors ?? []) as IValidationError[]), schema);
      }
      const nonFinite = nonFiniteErrors(data, true);
      if (nonFinite.length > 0) {
        throw new ValidationFailed('validation error', nonFinite, schema);
      }
    };
  }

  protected compileFailure(id: string, error: unknown): Error {
    // Ajv messages and stacks carry schema internals; only the unresolved reference is worth reporting.
    const { missingRef, missingSchema } = (error ?? {}) as { missingRef?: unknown; missingSchema?: unknown };
    if (typeof missingRef !== 'string') {
      return invalidSchema(id);
    }
    const target = typeof missingSchema === 'string' ? missingSchema : missingRef;
    if (this.unenforceable.has(manifestId(target))) {
      return new Error(`schema ${id} references ${manifestId(target)}, which declares a property named ${PROTO} that cannot be validated`);
    }
    return new Error(
      this.refused.has(target) ? `schema ${id} references ${manifestId(target)}, which is not a valid JSON Schema` : `schema ${id} has an unresolved $ref ${manifestId(missingRef)}`,
    );
  }

  protected ajv(coerce: boolean): Ajv {
    let ajv = this.instances.get(coerce);
    if (!ajv) {
      // No defaults or removal: the data is checked, never rewritten, apart from coercion of string inputs and
      // ajv-keywords' `transform`. strictNumbers: a query `?n=abc` converted to NaN is not a number.
      // `$data` and the keyword plugins as in DataValidator: the closure of a derived argument holds the published body
      // of an explicit `@Schema` class, whose `prohibited`, `range` or `$merge` would otherwise be skipped, and whose
      // `$data` limit would make Ajv refuse the whole argument. `verbose` lets `sanitizeError` find a `$data` rule.
      ajv = withFormats(new Ajv({ strict: false, strictNumbers: true, allErrors: true, messages: false, $data: true, verbose: true, coerceTypes: coerce ? 'array' : false }));
      // Before the plugin hook, as in DataValidator.createAjv(): a code keyword added after it installs every plugin.
      addSafeKeywords(ajv, { uniqueItemProperties: true });
      addKeywordPluginsOnUse(ajv);
      for (const schema of this.schemas.values()) {
        this.add(ajv, schema);
      }
      this.instances.set(coerce, ajv);
    }
    return ajv;
  }

  /** Ajv checks a schema against its meta-schema when it is added; one it refuses must not take the others down with it. */
  protected add(ajv: Ajv, schema: ISchemaObject): void {
    try {
      if (ajv.validateSchema(schema) === true) {
        ajv.addSchema(schema, undefined, undefined, false);
        return;
      }
    } catch {
      // A `$schema` Ajv does not know ( 2020-12 ) throws instead of failing the check.
    }
    this.refused.add(schema.$id);
  }
}

const VALIDATORS = new WeakMap<Manifest, ManifestValidator>();

export function manifestValidatorOf(manifest: Manifest): ManifestValidator {
  let validator = VALIDATORS.get(manifest);
  if (!validator) {
    validator = new ManifestValidator(manifest);
    VALIDATORS.set(manifest, validator);
  }
  return validator;
}

/**
 * Registers the schemas of the effective manifest in `DataValidator`, under {@link manifestSchemaKey}. Nothing without
 * a manifest or in `off` mode.
 */
@Injectable(SchemaSource)
export class ManifestSchemaSource extends SchemaSource {
  @Autoinject(Container)
  protected Container: IContainer;

  public Load(): Promise<ISchema[]> {
    const manifest = effectiveManifestOf(this.Container)?.manifest;
    return Promise.resolve(manifest ? prepareManifestSchemas(manifest).map((schema) => ({ schema, file: 'manifest' })) : []);
  }
}
