import { bodyOf } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { Schema } from '@spinajs/validation';

import { commandFields } from '../schemas/commands.js';
import { tags } from '../schemas/primitives.js';
import { AuthzAdminInput } from './input.js';

const LINK_PATCH_KEYS = ['expiresAt', 'attributes', 'role', 'tags'] as const;

export const LINK_CREATE_SCHEMA = {
  ...bodyOf(['scope', 'role'], commandFields('link.create'), 'authz.admin.AuthzLinkCreate'),
  description: 'POST /authz/links: the fields of link.create; the answer carries the token, shown once and sent with Cache-Control: no-store (reason, idempotencyKey and dryRun go in the query string)',
};

const { id, ...updateFields } = commandFields('link.update');

export const LINK_PATCH_SCHEMA = {
  ...bodyOf([], { id: { ...id, description: 'optional; must equal the path id' }, ...updateFields, tags: { ...tags, description: 'replaces the tags of the role the link grants' } }, 'authz.admin.AuthzLinkPatch'),
  description: 'PATCH /authz/links/{id}: at least one of expiresAt, attributes, role, tags; runs as one link.update',
  anyOf: LINK_PATCH_KEYS.map((k) => ({ required: [k] })),
};

/** The body of POST /authz/links. */
@Schema(LINK_CREATE_SCHEMA)
export class AuthzLinkCreate extends AuthzAdminInput {
  public scope: ResourceRef;
  public role: string;
  public tags?: string[];
  public expiresAt?: string | null;
  public attributes?: Record<string, unknown>;
}

/** The body of PATCH /authz/links/:id. */
@Schema(LINK_PATCH_SCHEMA)
export class AuthzLinkPatch extends AuthzAdminInput {
  public id?: string;
  public expiresAt?: string | null;
  public attributes?: Record<string, unknown>;
  public role?: string;
  public tags?: string[];
}
