import { bodyOf, idField, nameField, pageField, permissionField, typeField } from '@spinajs/authz';
import { Schema } from '@spinajs/validation';

import { writeOptions } from '../schemas/primitives.js';
import type { JsonSchema } from '../schemas/primitives.js';
import { AuthzAdminInput } from './input.js';

// `<type>:<id>` and `set:<role>@<type>:<id>` at the longest type, id and role the field schemas allow.
const SCOPE_MAX = typeField.maxLength + 1 + idField.maxLength;
const SUBJECT_MAX = 'set:'.length + nameField.maxLength + 1 + SCOPE_MAX;

const scope: JsonSchema = { type: 'string', minLength: 1, maxLength: SCOPE_MAX, description: '`<type>` or `<type>:<id>`, split at the first `:`; `$global` is the global scope' };
const subject: JsonSchema = { type: 'string', minLength: 1, maxLength: SUBJECT_MAX, description: '`<type>:<id>` (a principal) or `set:<role>@<type>:<id>` (a subject set)' };
const flag = (description: string): JsonSchema => ({ type: 'boolean', description });
const page: Record<string, JsonSchema> = {
  limit: { ...pageField.properties.limit, description: 'page size; the server sets the default' },
  offset: { ...pageField.properties.offset, description: 'rows to skip' },
  after: { ...pageField.properties.after, description: 'the `next` of the previous page: continues behind its last row; give it instead of `offset`' },
};
const { after: _after, ...offsetPage } = page;

export const ASSIGNMENTS_QUERY_SCHEMA = bodyOf([], { scope, subject, role: { ...nameField, description: 'only assignments of this role' }, includeExpired: flag('`true` or `false`'), ...page }, 'authz.admin.query.assignments');
export const HOLDERS_QUERY_SCHEMA = bodyOf(['scope', 'permission'], { scope, permission: { ...permissionField, description: 'the permission whose holders are listed (required)' }, expandSets: flag('`true` also lists the members of each subject set, next to the set itself'), ...page }, 'authz.admin.query.holders');
export const PAGE_QUERY_SCHEMA = bodyOf([], { scope, ...page }, 'authz.admin.query.page');
export const OFFSET_PAGE_QUERY_SCHEMA = bodyOf([], { scope, ...offsetPage }, 'authz.admin.query.offsetPage');
export const WRITE_OPTIONS_QUERY_SCHEMA = bodyOf([], writeOptions, 'authz.admin.query.writeOptions');

/** `limit`, `offset` and `after` of a list route. */
export abstract class AuthzAdminPageQuery extends AuthzAdminInput {
  public scope?: string;
  public limit?: number;
  public offset?: number;
  public after?: string;
}

/** The query string of GET /authz/assignments. */
@Schema(ASSIGNMENTS_QUERY_SCHEMA)
export class AuthzAssignmentsQuery extends AuthzAdminPageQuery {
  public subject?: string;
  public role?: string;
  public includeExpired?: boolean;
}

/** The query string of GET /authz/holders. */
@Schema(HOLDERS_QUERY_SCHEMA)
export class AuthzHoldersQuery extends AuthzAdminPageQuery {
  public permission: string;
  public expandSets?: boolean;
}

/** The query string of GET /authz/links and GET /authz/rules. */
@Schema(PAGE_QUERY_SCHEMA)
export class AuthzListQuery extends AuthzAdminPageQuery {}

/** The query string of GET /authz/policies, which pages by offset only. */
@Schema(OFFSET_PAGE_QUERY_SCHEMA)
export class AuthzOffsetListQuery extends AuthzAdminPageQuery {}

/** The query string of a single-command write route: the options of its batch. */
@Schema(WRITE_OPTIONS_QUERY_SCHEMA)
export class AuthzWriteOptionsQuery extends AuthzAdminInput {
  public reason?: string;
  public idempotencyKey?: string;
  public dryRun?: boolean;
}
