import { Constructor, DI } from '@spinajs/di';

export const SCHEMA_SYMBOL = Symbol('SCHEMA_SYMBOL');

/**
 *
 * Add schema for object eg. model or dto.
 *
 * @param schema - schema for object or schema name
 */
export function Schema(schema: object | string) {
  return (target: Constructor<any>) => {
    Reflect.defineMetadata(SCHEMA_SYMBOL, schema, target.prototype ?? target);
    // Register under '__schemas__' so the class can be resolved by name.

    if (typeof schema === 'object') {
      DI.register(schema).asMapValue('__schemas__', target.name);
    } else {

      // If schema is a string, we register a reference to it, so it can be resolved by name.
      // from validation package
      DI.register({
        $ref: schema
      }).asMapValue('__schemas__', target.name);
    }
  };
}
