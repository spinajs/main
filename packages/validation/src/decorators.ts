import { Constructor, DI } from '@spinajs/di';

export const SCHEMA_SYMBOL = Symbol('SCHEMA_SYMBOL');

/**
 * Every `@Schema`-decorated class by name, kept here as well as in the container.
 *
 * `asMapValue` stores its map in the container CACHE, and `DI.clearCache()` empties it - while
 * the decorator that filled it runs exactly once, when the module is first imported. Nothing
 * re-imports a module, so the first `clearCache()` after start-up destroys the name → schema
 * map for the rest of the process, and every lookup by name returns undefined from then on.
 * Silently: a DTO simply stops resolving, and the documentation that would have referenced it
 * degrades to a bare `{ type: 'object' }`.
 *
 * A decorator's output is process-global metadata about the code itself, not a resolved
 * service, so it has no business living somewhere a container reset can reach. This map is the
 * durable copy; the container registration stays for anything that reads `'__schemas__'`
 * directly.
 */
const SCHEMAS = new Map<string, object>();

/** The schema registered for a `@Schema`-decorated class name, or undefined. */
export function getRegisteredSchema(typeName: string): object | undefined {
  return SCHEMAS.get(typeName);
}

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

    // If schema is a string, we register a reference to it, so it can be resolved by name.
    // from validation package
    const registered = typeof schema === 'object' ? schema : { $ref: schema };

    SCHEMAS.set(target.name, registered);
    DI.register(registered).asMapValue('__schemas__', target.name);
  };
}
