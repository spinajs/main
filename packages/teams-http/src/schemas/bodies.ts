import { Schema } from '@spinajs/validation';

import { SUBJECT_PATTERN } from '../http/subjects.js';

// Fresh objects per use: http-swagger rewrites the schema nodes it walks.
export const slugSchema = () => ({ type: 'string', pattern: '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$', maxLength: 64, description: 'lower-case letters, digits and inner hyphens' });
export const nameSchema = () => ({ type: 'string', minLength: 1, maxLength: 128 });
export const descriptionSchema = () => ({ type: 'string', nullable: true, maxLength: 10000 });
export const idSchema = () => ({ type: 'string', minLength: 1, maxLength: 36 });
export const nullableIdSchema = () => ({ ...idSchema(), nullable: true });
export const subjectSchema = () => ({ type: 'string', pattern: SUBJECT_PATTERN, maxLength: 200, description: '`user:<id>`, `group:<id>` or `team:<id>`' });

export const object = (required: readonly string[], properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', additionalProperties: false, ...(required.length ? { required: [...required] } : {}), properties, ...extra });

@Schema(object(['slug', 'name'], { slug: slugSchema(), name: nameSchema(), description: descriptionSchema(), parentId: { ...nullableIdSchema(), description: 'the parent team; absent or null for a root team' } }, { title: 'CreateTeamBody' }))
export class CreateTeamBody {
  public slug: string;
  public name: string;
  public description?: string | null;
  public parentId?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object([], { slug: slugSchema(), name: nameSchema(), description: descriptionSchema() }, { title: 'UpdateTeamBody', minProperties: 1 }))
export class UpdateTeamBody {
  public slug?: string;
  public name?: string;
  public description?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['parentId'], { parentId: { ...nullableIdSchema(), description: 'the new parent team; null makes it a root team' } }, { title: 'MoveTeamBody' }))
export class MoveTeamBody {
  public parentId: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(
  object(
    ['to'],
    {
      to: { type: 'string', pattern: '^user:.+$', maxLength: 200, description: '`user:<id>`, the new owner' },
      keepAs: { type: 'string', nullable: true, minLength: 1, maxLength: 128, description: 'the role the previous owner keeps; default team.admin, null for none' },
    },
    { title: 'TransferTeamBody' },
  ),
)
export class TransferTeamBody {
  public to: string;
  public keepAs?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

export const roleSchema = () => ({ type: 'string', minLength: 1, maxLength: 128, description: 'a role name, e.g. team.member, team.admin' });

@Schema(object(['subject'], { subject: subjectSchema(), role: { ...roleSchema(), description: 'default team.member' } }, { title: 'AddTeamMemberBody' }))
export class AddTeamMemberBody {
  public subject: string;
  public role?: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['role'], { role: roleSchema() }, { title: 'SetRoleBody' }))
export class SetRoleBody {
  public role: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}
