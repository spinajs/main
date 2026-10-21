import { AuthzCommandSchemaSource } from '@spinajs/authz-http-admin';
import { Injectable } from '@spinajs/di';

/** The JSON schemas of tuple.write and tuple.delete for POST /authz/commands of @spinajs/authz-http-admin. */
@Injectable(AuthzCommandSchemaSource)
export class RebacCommandSchemas extends AuthzCommandSchemaSource {
  schemas(): Readonly<Record<string, object>> {
    throw new Error('not implemented: RebacCommandSchemas.schemas');
  }
}
