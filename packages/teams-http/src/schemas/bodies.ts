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

@Schema(object(['slug', 'name'], { slug: { ...slugSchema(), description: 'unique among the groups of the team' }, name: nameSchema(), description: descriptionSchema(), parentId: { ...nullableIdSchema(), description: 'an outer group of the same team' } }, { title: 'CreateGroupBody' }))
export class CreateGroupBody {
  public slug: string;
  public name: string;
  public description?: string | null;
  public parentId?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object([], { slug: slugSchema(), name: nameSchema(), description: descriptionSchema() }, { title: 'UpdateGroupBody', minProperties: 1 }))
export class UpdateGroupBody {
  public slug?: string;
  public name?: string;
  public description?: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['parentId'], { teamId: { ...idSchema(), description: "the team to move the group to; default the group's team" }, parentId: { ...nullableIdSchema(), description: 'the new outer group (same team); null for none' } }, { title: 'MoveGroupBody' }))
export class MoveGroupBody {
  public teamId?: string;
  public parentId: string | null;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['subject'], { subject: subjectSchema() }, { title: 'AddGroupMemberBody' }))
export class AddGroupMemberBody {
  public subject: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

export const INVITATION_MAX_HOURS = 8760;

@Schema(
  object(
    ['role'],
    {
      groupId: { ...idSchema(), description: 'join this group of the team instead of the team' },
      role: { ...roleSchema(), description: 'assigned on accept: a team role, or a group role with groupId; the inviter must be able to grant it' },
      email: { type: 'string', format: 'email', maxLength: 255, description: 'only this verified email may accept; absent for a shareable link' },
      maxUses: { type: 'integer', minimum: 1, nullable: true, description: 'default 1 for an email invitation, unlimited for a link; null for unlimited until expiry' },
      expiresInHours: { type: 'integer', minimum: 1, maximum: INVITATION_MAX_HOURS, description: 'default teams.invitations.defaultTtlHours' },
    },
    { title: 'CreateInvitationBody' },
  ),
)
export class CreateInvitationBody {
  public groupId?: string;
  public role: string;
  public email?: string;
  public maxUses?: number | null;
  public expiresInHours?: number;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}

@Schema(object(['token'], { token: { type: 'string', minLength: 1, maxLength: 256, description: 'the token of the create answer or the invitation mail' } }, { title: 'AcceptInvitationBody' }))
export class AcceptInvitationBody {
  public token: string;

  constructor(data: Record<string, unknown>) {
    Object.assign(this, data);
  }
}
