import { Autoinject, Injectable } from '@spinajs/di';
import { SchemaProvider } from '@spinajs/validation';

import * as answers from './answers.js';
import type { JsonSchema } from './primitives.js';
import { AuthzCommandSchemaRegistry } from './registry.js';

/** The answer and error schemas of the admin routes by name, as the swagger document names them. Request schemas live on the DTOs. */
export const AUTHZ_ADMIN_SCHEMAS: Readonly<Record<string, JsonSchema>> = { ...answers };

/**
 * Serves the answer schemas and the batch body to http-swagger by the type names the controller's
 * `@response` tags and `describeAuthzAdminDocument` use. The batch body is built from the registered
 * AuthzCommandSchemaSources on every call, as the batch route validates against it.
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
