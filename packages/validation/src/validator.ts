import { SyncModule, Autoinject, Container } from '@spinajs/di';
import Ajv from 'ajv';
import { Config } from '@spinajs/configuration';
import { IValidationError, ValidationFailed } from './exceptions';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { SCHEMA_SYMBOL } from './decorators';
import { IValidationOptions, SchemaSource, ISchemaObject } from './types';
import { Logger, ILog } from '@spinajs/log';

export class DataValidator extends SyncModule {
  @Config('validation')
  public Options: IValidationOptions;

  @Autoinject(SchemaSource)
  protected Sources: SchemaSource[];

  @Logger('validation')
  protected Log: ILog;

  protected Validator: Ajv;

  @Autoinject()
  protected Container: Container;

  public resolve() {
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
    };

    this.Validator = new Ajv(ajvConfig);

    // add $merge & $patch for json schema
    require('ajv-merge-patch')(this.Validator);

    // add common formats validation eg: date time
    require('ajv-formats')(this.Validator);

    // add keywords
    require('ajv-keywords')(this.Validator);

    this.Sources.map((x) => x.Load())
      .reduce((prev, curr) => {
        return prev.concat(curr);
      }, [])
      .filter((s) => {
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

    super.resolve();
  }

  public addSchema(schemaObject: object, identifier: string) {
    if (!this.hasSchema(identifier)) {
      this.Validator.addSchema(schemaObject, identifier);
      this.Log.trace(`Schema ${identifier} added !`, 'validator');
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

  /**
   * Tries to validate given data
   *
   * @param data - data to validate. Function will try to extract schema attached to object via `@Schema` decorator
   *
   */
  public tryValidate(data: object): [boolean, IValidationError[]];
  /**
   * Tries to validate given data
   *
   * @param  schemaKeyRef - key, ref or schema object
   * @param  data - to be validated
   */
  public tryValidate(schema: object | string, data: object): [boolean, IValidationError[]];
  public tryValidate(schemaOrData: object | string, data?: object): [boolean, IValidationError[] | null] {
    let schema: ISchemaObject = null;

    if (data === null || data === undefined) {
      schema = Reflect.getMetadata(SCHEMA_SYMBOL, schemaOrData) as ISchemaObject;
    } else {
      if (typeof schemaOrData === 'object') {
        schema = schemaOrData as ISchemaObject;
      } else if (typeof schemaOrData === 'string') {
        /* eslint-disable */
        schema = (this.Validator.getSchema(schemaOrData) as any)?.schema ?? null;
      } else {
        schema = Reflect.getMetadata(SCHEMA_SYMBOL, schemaOrData) as ISchemaObject;
      }
    }

    if (schema) {
      const result = this.Validator.validate(schema, data !== null && data !== undefined ? data : schemaOrData);
      if (!result) {
        return [false, this.Validator.errors ?? null];
      }
    }

    return [true, null];
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
    const [isValid, errors] = this.tryValidate(schemaOrData, data);
    if (!isValid) {
      switch (errors[0].keyword) {
        case 'invalid_argument':
          throw new InvalidArgument('data is null or undefined');
        case 'empty_schema':
          throw new InvalidArgument('objects schema is not set');
        default:
          throw new ValidationFailed('validation error', errors);
      }
    }
  }
}
