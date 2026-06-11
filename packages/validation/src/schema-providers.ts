import { Autoinject, DI, Injectable, Singleton, SyncService } from '@spinajs/di';
import { DataValidator } from './validator.js';

/**
 * Resolves a type name to its JSON schema. Each provider handles one kind of type
 * and returns undefined for names it doesn't recognise.
 */
@Singleton()
export abstract class SchemaProvider extends SyncService {
  /**
   * Returns the JSON schema for `typeName`, or undefined if this provider doesn't know it.
   *
   * @param typeName
   */
  public abstract getSchema(typeName: string): Record<string, unknown> | undefined;
}
 

/**
 * Resolves a `@Schema`-decorated DTO name to the schema stored on the class. The
 * class is found via the `'__schemas__'` registry that `@Schema` populates.
 */
@Injectable(SchemaProvider)
export class DtoSchemaProvider extends SchemaProvider {

  @Autoinject()
  protected Validator!: DataValidator;

  public getSchema(typeName: string): Record<string, unknown> | undefined {

    const schemas = DI.get<Map<string, any>>('__schemas__');
    if (!schemas) {
      return undefined;
    }

    const schema = schemas.get(typeName);
    if(schema && typeof schema === 'object' && '$ref' in schema) {
        return this.Validator.getSchema(schema.$ref)?.schema as Record<string, unknown> | undefined;
    }

    return schema;
  }
}
