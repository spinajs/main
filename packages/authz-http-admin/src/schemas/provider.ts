import { Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';

import * as bodies from './bodies.js';
import type { JsonSchema } from './primitives.js';

/** Every schema of the admin routes by name, as the swagger document names them. */
export const AUTHZ_ADMIN_SCHEMAS: Readonly<Record<string, JsonSchema>> = { ...bodies };

/**
 * Serves the schemas to http-swagger by the type names the controller's `@response` tags use.
 * Nothing but the swagger builder asks a SchemaProvider: request validation reads `@Schema`
 * metadata and route argument schemas, neither of which these routes carry.
 */
@Injectable(SchemaProvider)
export class AuthzAdminSchemaProvider extends SchemaProvider {
  public getSchema(typeName: string): Record<string, unknown> | undefined {
    return Object.hasOwn(AUTHZ_ADMIN_SCHEMAS, typeName) ? AUTHZ_ADMIN_SCHEMAS[typeName] : undefined;
  }
}
