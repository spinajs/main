import { Autoinject, Container, AsyncService, Singleton } from '@spinajs/di';
import Ajv from 'ajv';
import { Config } from '@spinajs/configuration';
import { IValidationError, ValidationFailed } from './exceptions/index.js';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { SCHEMA_SYMBOL } from './decorators.js';
import { IValidationOptions, SchemaSource, ISchemaObject } from './types.js';
import { Logger, Log } from '@spinajs/log-common';

// import default souces
import './sources.js';


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

  @Autoinject()
  protected Container: Container;

  public async resolve() {
    if (!this.Sources || this.Sources.length === 0) {
      throw new InvalidOperation('No schema sources avaible. Register any in DI container');
    }

    const ajvConfig = {
      logger: {
        log: (msg: string) => this.Log.info(msg),
        warn: (msg: string) => this.Log.warn(msg),
        error: (msg: string) => this.Log.error(msg),
      },
      ...this.Options,
      $data: true,
    };


    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
    const AjvConstructor = resolveDefault(Ajv);
    this.Validator = new AjvConstructor(ajvConfig);

    // add $merge & $patch for json schema
    resolveDefault(ajvMergePath)(this.Validator);

    // add common formats validation eg: date time
    resolveDefault(ajvFormats)(this.Validator);

    // add keywords
    resolveDefault(ajvKeywords)(this.Validator);
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

    const pSources = this.Sources.map((x) => x.Load());
    const result = await Promise.all(pSources);

    result
      .reduce((prev, curr) => {
        return prev.concat(curr);
      }, [])
      .filter((s) => {
        if (!s.schema || typeof s.schema !== 'object' || !s.schema.$id) {
          this.Log.error(`Schema at ${s.file} is empty or has no $id property`, 'validator');
          return false;
        }

        // validate schema can throw sometimes
        try {
          const vResult = this.Validator.validateSchema(s.schema, true);
          if (!vResult) {
            this.Log.error(`Schema at ${s.file} invalid`, 'validator');

            return false;
          }

          return true;
        } catch (err) {
          this.Log.error(`Schema at ${s.file} invalid, reason: ${(err as Error).message}`, 'validator');
          return false;
        }
      })
      .forEach((s) => {
        this.addSchema(s.schema, s.schema.$id);
      });

    await super.resolve();
  }

  public addSchema(schemaObject: object, identifier: string) {
    if (this.hasSchema(identifier)) {
      this.Log.warn(`Schema ${identifier} already registered, skipping`, 'validator');
      return;
    }

    this.Validator.addSchema(schemaObject, identifier);
    this.Log.trace(`Schema ${identifier} added !`, 'validator');
  }

  /**
   * Removes schema from validator. Does nothing if schema is not registered.
   *
   * @param schemaId - id of schema to remove
   */
  public removeSchema(schemaId: string): void {
    if (this.hasSchema(schemaId)) {
      this.Validator.removeSchema(schemaId);
      this.Log.trace(`Schema ${schemaId} removed !`, 'validator');
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
    const target = data !== null && data !== undefined ? data : schemaOrData;

    if (target === null || target === undefined) {
      return [false, [syntheticError('invalid_argument', 'data is null or undefined')]];
    }

    const schema = this.resolveSchema(schemaOrData, data);
    if (!schema) {
      return [false, [syntheticError('empty_schema', 'objects schema is not set')]];
    }

    const result = this.Validator.validate(schema, target);
    if (!result) {
      return [false, (this.Validator.errors as IValidationError[]) ?? []];
    }

    return [true, null];
  }

  /**
   * Internal method to get the schema being used for validation
   */
  private resolveSchema(schemaOrData: object | string, data?: object): ISchemaObject | null {
    if (data === null || data === undefined) {
      return (Reflect.getMetadata(SCHEMA_SYMBOL, schemaOrData) as ISchemaObject) ?? null;
    }

    if (typeof schemaOrData === 'string') {
      /* eslint-disable */
      return ((this.Validator.getSchema(schemaOrData) as any)?.schema as ISchemaObject) ?? null;
      /* eslint-enable */
    }

    return schemaOrData as ISchemaObject;
  }

  public extractSchema(object: any) {
    return Reflect.getMetadata(SCHEMA_SYMBOL, object) as ISchemaObject ?? Reflect.getMetadata(SCHEMA_SYMBOL, object.prototype) as ISchemaObject;
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
    const [isValid, errors] = this.tryValidate(schemaOrData, data!);
    if (!isValid) {
      switch (errors![0]?.keyword) {
        case 'invalid_argument':
          throw new InvalidArgument('data is null or undefined');
        case 'empty_schema':
          throw new InvalidArgument('objects schema is not set');
        default: {
          const validatedData = data !== null && data !== undefined ? data : schemaOrData;
          const usedSchema = this.resolveSchema(schemaOrData, data);
          throw new ValidationFailed('validation error', errors ?? [], validatedData, usedSchema);
        }
      }
    }
  }
}
