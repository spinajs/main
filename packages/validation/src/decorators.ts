import { DI } from '@spinajs/di';

export const SCHEMA_SYMBOL = Symbol('SCHEMA_SYMBOL');

/**
 *
 * Add schema for object eg. model or dto.
 *
 * @param schema - schema for object or schema name
 */
export function Schema(schema: object | string) {
  return (target: any) => {
    Reflect.defineMetadata(SCHEMA_SYMBOL, schema, target.prototype ?? target);
    // Register under '__schemas__' so the class can be resolved by name.
    DI.register(target).as('__schemas__');
  };
}
