import { Autoinject, Container, AsyncService, Singleton } from '@spinajs/di';
import Ajv from 'ajv';
import { Config } from '@spinajs/configuration';
import { IValidationError, ValidationFailed, sanitizeError } from './exceptions/index.js';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { SCHEMA_SYMBOL } from './decorators.js';
import { IValidationOptions, SchemaSource, ISchemaObject } from './types.js';
import { Logger, Log } from '@spinajs/log-common';
import { isStandardSchema, toValidationErrors, type StandardSchemaV1 } from './standard-schema.js';

// import default souces
import './sources.js';
// The package index loads no Bootstrapper: the schema module registers itself.
import './schemas/validation.js';


import { default as ajvMergePath } from 'ajv-merge-patch';
import { default as ajvFormats } from 'ajv-formats';
import { default as ajvKeywords } from 'ajv-keywords';


/**
 * HACK:
 * Becouse of ajv not supporting esm default exports we need to
 * check for default export module property and if not provided use module itself
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolveDefault = (mod: any): any => mod?.default ?? mod;

// The members of the strict Ajv instance used here; `Validator` stays `any` for subclasses.
interface StrictAjv {
  addSchema(schema: object, key: string): unknown;
  removeSchema(key: string): unknown;
}

export const DEFAULT_STRICT_ID_PREFIXES: readonly string[] = ['authn.', 'authz.'];

const syntheticError = (keyword: string, message: string): IValidationError =>
  ({
    keyword,
    instancePath: '',
    schemaPath: '',
    params: {},
    message,
  } as IValidationError);

@Singleton()
export class DataValidator extends AsyncService {
  @Config('validation')
  public Options: IValidationOptions;

  @Autoinject(SchemaSource)
  protected Sources: SchemaSource[];

  @Logger('validation')
  protected Log: Log;

  /**
   * We ignore this error because ajv have problems with
   * commonjs / esm default exports
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected Validator: any;

  /**
   * Same options and schemas as `Validator`, with `coerceTypes: false`; used for schemas whose `$id` has a strict prefix.
   */
  protected StrictValidator: StrictAjv;

  protected StrictIdPrefixes: readonly string[] = DEFAULT_STRICT_ID_PREFIXES;

  @Autoinject()
  protected Container: Container;

  public async resolve() {
    if (!this.Sources || this.Sources.length === 0) {
      throw new InvalidOperation('No schema sources avaible. Register any in DI container');
    }

    // An object `strict` holds the strict schema ids; a boolean or 'log' is still Ajv's own strict mode.
    const { strict, ...ajvOptions } = this.Options ?? ({} as IValidationOptions);
    const strictIds = typeof strict === 'object' && strict !== null ? strict : undefined;
    const ajvStrict = strictIds ? strictIds.ajvStrict : strict;
    this.StrictIdPrefixes = strictIds?.idPrefixes ?? DEFAULT_STRICT_ID_PREFIXES;

    const ajvConfig = {
      logger: {
        log: (msg: string) => this.Log.info(msg),
        warn: (msg: string) => this.Log.warn(msg),
        error: (msg: string) => this.Log.error(msg),
      },
      ...ajvOptions,
      ...(ajvStrict === undefined ? {} : { strict: ajvStrict }),
      $data: true,
      // `parentSchema` tells sanitizeError which rules are `$data` refs; no error leaves this class unsanitised.
      verbose: true,
    };


    this.Validator = this.createAjv(ajvConfig);
    this.StrictValidator = this.createAjv({ ...ajvConfig, coerceTypes: false });

    const pSources = this.Sources.map((x) => x.Load());
    const result = await Promise.all(pSources);

    result
      .reduce((prev, curr) => {
        return prev.concat(curr);
      }, [])
      .filter((s) => {
        if (!s.schema || typeof s.schema !== 'object' || !s.schema.$id) {
          this.Log.error({ file: s.file }, 'Schema at ${file} is empty or has no $id property');
          return false;
        }

        // validate schema can throw sometimes
        try {
          const vResult = this.Validator.validateSchema(s.schema, true);
          if (!vResult) {
            this.Log.error({ file: s.file }, 'Schema at ${file} invalid');

            return false;
          }

          return true;
        } catch (err) {
          this.Log.error({ error: err, file: s.file }, 'Schema at ${file} invalid');
          return false;
        }
      })
      .forEach((s) => {
        this.addSchema(s.schema, s.schema.$id);
      });

    await super.resolve();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected createAjv(options: object): any {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
    const AjvConstructor = resolveDefault(Ajv);
    const ajv = new AjvConstructor(options);

    // add $merge & $patch for json schema
    resolveDefault(ajvMergePath)(ajv);

    // add common formats validation eg: date time
    resolveDefault(ajvFormats)(ajv);

    // add keywords
    resolveDefault(ajvKeywords)(ajv);
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

    return ajv;
  }

  /**
   * True when `schema` ( an object or a registered id ) is validated without type coercion.
   */
  public isStrict(schema: object | string): boolean {
    const id = typeof schema === 'string' ? schema : (schema as Record<string, unknown>)?.$id;
    return typeof id === 'string' && this.StrictIdPrefixes.some((prefix) => id.startsWith(prefix));
  }

  public addSchema(schemaObject: object, identifier: string) {
    if (this.hasSchema(identifier)) {
      this.Log.warn({ schema: identifier }, 'Schema ${schema} already registered, skipping');
      return;
    }

    // Both instances hold every schema, so a $ref from a strict schema resolves on the strict one.
    this.Validator.addSchema(schemaObject, identifier);
    this.StrictValidator.addSchema(schemaObject, identifier);
    this.Log.trace({ schema: identifier }, 'Schema ${schema} added !');
  }

  /**
   * Removes schema from validator. Does nothing if schema is not registered.
   *
   * @param schemaId - id of schema to remove
   */
  public removeSchema(schemaId: string): void {
    if (this.hasSchema(schemaId)) {
      this.Validator.removeSchema(schemaId);
      this.StrictValidator.removeSchema(schemaId);
      this.Log.trace({ schema: schemaId }, 'Schema ${schema} removed !');
    }
  }

  /**
   *
   * Checks if schema is loaded ( from file )
   *
   * @param schemaId - schema id to check
   * @returns  true if schema is loaded, false otherwise
   */
  public hasSchema(schemaId: string): boolean {
    return !!this.Validator.getSchema(schemaId);
  }

  public getSchema(schemaId: string): Record<string, unknown> | undefined {
    return this.Validator.getSchema(schemaId)?.schema;
  }

  /**
   * Tries to validate given data. When schema cannot be resolved ( unknown schema id,
   * object without `@Schema` decorator ) or data is null / undefined, validation FAILS
   * with a synthetic `empty_schema` / `invalid_argument` error.
   *
   * @param data - data to validate. Function will try to extract schema attached to object via `@Schema` decorator
   *
   */
  public tryValidate(data: object): [boolean, IValidationError[] | null];
  /**
   * Tries to validate given data
   *
   * @param  schemaKeyRef - key, ref or schema object
   * @param  data - to be validated
   */
  public tryValidate(schema: object | string, data: object): [boolean, IValidationError[] | null];
  public tryValidate(schemaOrData: object | string, data?: object): [boolean, IValidationError[] | null] {
    return this.tryValidateInternal(arguments.length > 1, schemaOrData, data);
  }

  private tryValidateInternal(hasSchemaArg: boolean, schemaOrData: object | string, data?: object): [boolean, IValidationError[] | null] {
    const target = hasSchemaArg ? data : schemaOrData;

    if (target === null || target === undefined) {
      return [false, [syntheticError('invalid_argument', 'data is null or undefined')]];
    }

    const schema = this.resolveSchema(hasSchemaArg, schemaOrData);
    if (!schema) {
      return [false, [syntheticError('empty_schema', 'objects schema is not set')]];
    }

    if (isStandardSchema(schema)) {
      return this.validateStandard(schema, target);
    }

    const strict = this.isStrict(schema) || (hasSchemaArg && typeof schemaOrData === 'string' && this.isStrict(schemaOrData));
    const ajv = strict ? this.StrictValidator : this.Validator;
    const result = ajv.validate(this.uniqueIdSchema(schema, ajv), target);
    if (!result) {
      return [false, this.sanitizedErrors(schema, ajv)];
    }

    return [true, null];
  }

  private validateStandard(schema: StandardSchemaV1, data: unknown): [boolean, IValidationError[] | null] {
    let result: ReturnType<StandardSchemaV1['~standard']['validate']>;
    try {
      result = schema['~standard'].validate(data);
    } catch {
      // A library's own error text may quote the offending value.
      return [false, [syntheticError('standardSchema', 'schema validator failed')]];
    }

    if (result instanceof Promise) {
      void result.catch(() => undefined);
      throw new InvalidOperation(`Standard Schema validator (${schema['~standard'].vendor}) is asynchronous; synchronous validation cannot await it`);
    }

    return result.issues ? [false, toValidationErrors(result.issues)] : [true, null];
  }

  /**
   * Checks that `schema` is ITSELF a valid JSON Schema - the meta-schema check, plus a compile
   * attempt, because the two catch different things: the meta-schema accepts any string as a
   * `format`, and only compiling discovers that no such format is registered.
   *
   * For schemas that arrive at runtime ( stored in a column, sent by a client ) rather than
   * shipped with the code, so a malformed one is refused where it is written instead of throwing
   * later, at every attempt to validate data against it.
   */
  public validateSchema(schema: object): [boolean, IValidationError[] | null] {
    if (schema === null || schema === undefined || typeof schema !== 'object') {
      return [false, [syntheticError('invalid_argument', 'schema is null, undefined or not an object')]];
    }

    try {
      const isValid = this.Validator.validateSchema(schema) as boolean;

      if (!isValid) {
        return [false, this.sanitizedErrors()];
      }

      // meta-valid but uncompilable - an unknown `format`, an unresolvable `$ref`
      // compile() registers a `$id` in Ajv, which would clash with an already registered schema
      const { $id, ...unregistered } = schema as Record<string, unknown>;
      this.Validator.compile(unregistered);

      return [true, null];
    } catch (err) {
      return [false, [syntheticError('invalid_schema', (err as Error).message)]];
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sanitizedErrors(schema?: object, ajv: any = this.Validator): IValidationError[] {
    return ((ajv.errors as IValidationError[]) ?? []).map((error) => sanitizeError(error, schema));
  }

  /**
   * Internal method to get the schema being used for validation
   */
  private resolveSchema(hasSchemaArg: boolean, schemaOrData: object | string): ISchemaObject | null {
    if (!hasSchemaArg) {
      return this.extractSchema(schemaOrData) ?? null;
    }

    if (typeof schemaOrData === 'string') {
      /* eslint-disable */
      return ((this.Validator.getSchema(schemaOrData) as any)?.schema as ISchemaObject) ?? null;
      /* eslint-enable */
    }

    if (typeof schemaOrData === 'function') {
      return this.extractSchema(schemaOrData) ?? null;
    }

    return schemaOrData as ISchemaObject;
  }

  // Ajv registers an inline schema's `$id` globally; a different object reusing a taken `$id` would throw.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uniqueIdSchema(schema: ISchemaObject, ajv: any): ISchemaObject {
    const id = (schema as Record<string, unknown>).$id;
    if (typeof id !== 'string' || !ajv.getSchema(id) || ajv.getSchema(id)?.schema === schema) {
      return schema;
    }

    let copy = this.unregisteredSchemas.get(schema);
    if (!copy) {
      const { $id, ...rest } = schema as Record<string, unknown>;
      copy = rest as ISchemaObject;
      this.unregisteredSchemas.set(schema, copy);
    }
    return copy;
  }

  private unregisteredSchemas = new WeakMap<object, ISchemaObject>();

  public extractSchema(object: any) {
    if (object === null || object === undefined) {
      return undefined as unknown as ISchemaObject;
    }
    return (Reflect.getMetadata(SCHEMA_SYMBOL, object) as ISchemaObject) ?? (object.prototype ? (Reflect.getMetadata(SCHEMA_SYMBOL, object.prototype) as ISchemaObject) : (undefined as unknown as ISchemaObject));
  }

  /**
   * Validate given data. When failed, exception is thrown
   *s
   * @param data - data to validate. Function will try to extract schema attached to object via `@Schema` decorator
   * @throws {@link InvalidArgument | ValidationFailed }
   */
  public validate(data: object): void;

  /**
   * Validate given data
   *
   * @param  schemaKeyRef - key, ref or schema object
   * @param  data - to be validated
   * @throws {@link InvalidArgumen | ValidationFailed }
   */
  public validate(schema: object | string, data: object): void;
  public validate(schemaOrData: object | string, data?: object): void {
    const hasSchemaArg = arguments.length > 1;
    const [isValid, errors] = this.tryValidateInternal(hasSchemaArg, schemaOrData, data);
    if (!isValid) {
      switch (errors![0]?.keyword) {
        case 'invalid_argument':
          throw new InvalidArgument('data is null or undefined');
        case 'empty_schema':
          throw new InvalidArgument('objects schema is not set');
        default: {
          throw new ValidationFailed('validation error', errors ?? [], this.resolveSchema(hasSchemaArg, schemaOrData));
        }
      }
    }
  }
}
