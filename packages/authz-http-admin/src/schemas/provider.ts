import { Autoinject, Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';

import * as bodies from './bodies.js';
import type { JsonSchema } from './primitives.js';
import { AuthzCommandSchemaRegistry } from './registry.js';

/** Every schema of the admin routes by name, as the swagger document names them, over the built-in commands. */
export const AUTHZ_ADMIN_SCHEMAS: Readonly<Record<string, JsonSchema>> = { ...bodies };

/**
 * Serves the schemas to http-swagger by the type names the controller's `@response` tags use.
 * Nothing but the swagger builder asks a SchemaProvider: request validation reads `@Schema`
 * metadata and route argument schemas, neither of which these routes carry.
 */
@Injectable(SchemaProvider)
export class AuthzAdminSchemaProvider extends SchemaProvider {
  @Autoinject(AuthzCommandSchemaRegistry)
  protected Registry: AuthzCommandSchemaRegistry;

  /** Every schema of the admin routes by name, with AuthzAdminBatch listing the registered command kinds. */
  public schemas(): Readonly<Record<string, JsonSchema>> {
    return { ...AUTHZ_ADMIN_SCHEMAS, AuthzAdminBatch: this.Registry.batch() };
  }

  public getSchema(typeName: string): Record<string, unknown> | undefined {
    if (typeName === 'AuthzAdminBatch') return this.Registry.batch();
    return Object.hasOwn(AUTHZ_ADMIN_SCHEMAS, typeName) ? AUTHZ_ADMIN_SCHEMAS[typeName] : undefined;
  }
}
