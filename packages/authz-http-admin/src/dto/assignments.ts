import { bodyOf } from '@spinajs/authz';
import type { PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Schema } from '@spinajs/validation';

import { commandFields } from '../schemas/commands.js';
import { nullableDateTime, tags } from '../schemas/primitives.js';
import { AuthzAdminInput } from './input.js';

const PATCH_KEYS = ['tags', 'addTags', 'removeTags', 'expiresAt'] as const;

export const ASSIGNMENT_GRANT_SCHEMA = {
  ...bodyOf(['subject', 'role', 'scope'], commandFields('assignment.grant'), 'authz.admin.AuthzAssignmentGrant'),
  description: 'POST /authz/assignments: the fields of assignment.grant (reason, idempotencyKey and dryRun go in the query string)',
};

export const ASSIGNMENT_PATCH_SCHEMA = {
  ...bodyOf([], { tags: { ...tags, description: 'replaces the tags' }, addTags: tags, removeTags: tags, expiresAt: nullableDateTime }, 'authz.admin.AuthzAssignmentPatch'),
  description: 'PATCH /authz/assignments/{id}: at least one key; the keys run as assignment.setTags, addTags, removeTags and setExpiry in one batch',
  anyOf: PATCH_KEYS.map((k) => ({ required: [k] })),
};

/** The body of POST /authz/assignments. */
@Schema(ASSIGNMENT_GRANT_SCHEMA)
export class AuthzAssignmentGrant extends AuthzAdminInput {
  public subject: PrincipalRef | { readonly set: { readonly role: string; readonly scope: ResourceRef } };
  public role: string;
  public scope: ResourceRef;
  public tags?: string[];
  public expiresAt?: string | null;
  public replaceLadder?: boolean;
}

/** The body of PATCH /authz/assignments/:id. */
@Schema(ASSIGNMENT_PATCH_SCHEMA)
export class AuthzAssignmentPatch extends AuthzAdminInput {
  public tags?: string[];
  public addTags?: string[];
  public removeTags?: string[];
  public expiresAt?: string | null;
}
