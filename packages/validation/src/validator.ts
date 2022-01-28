import { SyncModule, IContainer } from '@spinajs/di';
import Ajv from 'ajv';
import { Config } from '@spinajs/configuration';
import { IValidationError, ValidationFailed } from './exceptions';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { SCHEMA_SYMBOL } from './decorators';
import { Log } from '@spinajs/log/lib/log';
import { SchemaSource } from './sources';

export class DataValidator extends SyncModule {
  @Config('validation')
  public Options: any;

  protected Sources: SchemaSource[];

  protected Validator: Ajv;

  protected Container: IContainer;

  public resolve(container: IContainer) {
    this.Sources = container.resolve(Array.ofType(SchemaSource));

    if (!this.Sources || this.Sources.length === 0) {
      throw new InvalidOperation('No schema sources avaible. Register any in DI container');
    }

    const ajvConfig = {
      logger: {
        log: (msg: string) => Log.info(msg, 'validation'),
        warn: (msg: string) => Log.warn(msg, 'validation'),
        error: (msg: string) => Log.error(msg, 'validation'),
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

    this.Sources.map(x => x.Load())
      .reduce((prev, curr) => {
        return prev.concat(curr);
      }, [])
      .filter(s => {
        // validate schema can throw sometimes
        try {
          const vResult = this.Validator.validateSchema(s.schema, true);
          if (!vResult) {
            Log.error(`Schema at ${s.file} invalid`, 'validator');

            return false;
          }

          return true;
        } catch (err) {
          Log.error(`Schema at ${s.file} invalid, reason: ${err.message}`, 'validator');
          return false;
        }
      })
      .forEach(s => {
        this.addSchema(s.schema, s.schema.$id);
      });

    super.resolve(container);
  }

  public addSchema(schemaObject: any, identifier: string) {
    if (!this.hasSchema(identifier)) {
      this.Validator.addSchema(schemaObject, identifier);
      Log.trace(`Schema ${identifier} added !`, 'validator');
    }
  }

  /**
   *
   * Checks if schema is loaded ( from file )
   *
   * @param schemaId schema id to check
   * @returns { boolean } true if schema is loaded, false otherwise
   */
  public hasSchema(schemaId: string): boolean {
    return !!this.Validator.getSchema(schemaId);
  }

  /**
   * Tries to validate given data
   *
   * @param data data to validate. Function will try to extract schema attached to object via @Schema decorator
   * @return { array : [boolean, ValidationError[]]} [0] true if data is valid, false otherwise, [1] list of all errors. If
   *                                                 set in config validation.allErrors is set to false, only firs error is returned
   */
  public tryValidate(data: any): [boolean, IValidationError[]];
  /**
   * Tries to validate given data
   *
   * @param  {string|object|Boolean} schemaKeyRef key, ref or schema object
   * @param  {Any} data to be validated
   * @return { array : [boolean, ValidationError[]]} [0] true if data is valid, false otherwise, [1] list of all errors. If
   *                                                 set in config validation.allErrors is set to false, only firs error is returned
   */
  public tryValidate(schema: object | string, data: any): [boolean, IValidationError[]];
  public tryValidate(schemaOrData: object | string, data?: any): [boolean, IValidationError[] | null] {
    if (arguments.length === 1) {
      const schema = Reflect.getMetadata(SCHEMA_SYMBOL, schemaOrData);

      if (!schema) {
        return [
          false,
          [
            {
              keyword: 'empty_schema',
              instancePath: './',
              schemaPath: '',
              params: { data: '' },
            },
          ],
        ];
      }

      const result = this.Validator.validate(schema, schemaOrData);
      if (!result) {
        return [false, this.Validator.errors ?? null];
      }
    } else {
      if (!data) {
        return [
          false,
          [
            {
              keyword: 'invalid_argument',
              instancePath: './',
              schemaPath: '',
              params: { data: '' },
            },
          ],
        ];
      }

      let schema = null;

      if (typeof schemaOrData === 'object') {
        schema = schemaOrData;
      } else if (typeof schemaOrData === 'string') {
        const s = this.Validator.getSchema(schemaOrData);
        schema = s?.schema;
      } else {
        schema = Reflect.getMetadata(SCHEMA_SYMBOL, schemaOrData);
      }

      if (!schema) {
        return [
          false,
          [
            {
              keyword: 'empty_schema',
              instancePath: './',
              schemaPath: '',
              params: { data: '' },
            },
          ],
        ];
      }

      const result = this.Validator.validate(schema, data);
      if (!result) {
        return [false, this.Validator.errors ?? null];
      }
    }

    return [true, null];
  }

  /**
   * Validate given data. When failed, exception is thrown
   *
   * @param data data to validate. Function will try to extract schema attached to object via @Schema decorator
   * @throws {InvalidArgument | ValidationFailed }
   */
  public validate(data: any): void;

  /**
   * Validate given data
   *
   * @param  {string|object|Boolean} schemaKeyRef key, ref or schema object
   * @param  {Any} data to be validated
   * @throws {InvalidArgumen | ValidationFailed }
   */
  public validate(schema: object | string, data: any): void;
  public validate(schemaOrData: object | string, data?: any): void {
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
