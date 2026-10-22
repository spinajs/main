import { Schema } from '@spinajs/validation';

import { AuthzAdminInput } from './input.js';

// Open maps: core's flattenAttributes refuses bad keys, depth, size and leaf values with invalid_attributes.
export const ATTRIBUTES_PATCH_SCHEMA = { $id: 'authz.admin.AuthzAttributesPatch', type: 'object', description: 'PATCH /authz/scopes/{type}/{id}/attributes: deep merge; null deletes a path' };
export const ATTRIBUTES_BODY_SCHEMA = { $id: 'authz.admin.AuthzAttributesBody', type: 'object', description: 'PUT /authz/scopes/{type}/{id}/attributes: replaces all attributes' };

/** The body of PATCH /authz/scopes/:type/:id/attributes. */
@Schema(ATTRIBUTES_PATCH_SCHEMA)
export class AuthzAttributesPatch extends AuthzAdminInput {
  [path: string]: unknown;
}

/** The body of PUT /authz/scopes/:type/:id/attributes. */
@Schema(ATTRIBUTES_BODY_SCHEMA)
export class AuthzAttributesBody extends AuthzAdminInput {
  [path: string]: unknown;
}
