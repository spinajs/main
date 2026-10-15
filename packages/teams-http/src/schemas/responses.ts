export type JsonSchema = Record<string, unknown>;

const text: JsonSchema = { type: 'string' };
const nullableText: JsonSchema = { type: 'string', nullable: true };
const stamp: JsonSchema = { type: 'string', format: 'date-time', description: 'ISO 8601' };
const nullableStamp: JsonSchema = { ...stamp, nullable: true };
const roles: JsonSchema = { type: 'array', items: text };

function obj(required: readonly string[], properties: Record<string, JsonSchema>, description: string): JsonSchema {
  return { type: 'object', description, required: [...required], properties };
}

function page(item: JsonSchema, description: string): JsonSchema {
  return obj(['items', 'total'], { items: { type: 'array', items: item }, total: { type: 'integer', minimum: 0 } }, description);
}

function withRoles(view: JsonSchema, description: string): JsonSchema {
  return obj([...(view.required as string[]), 'roles'], { ...(view.properties as Record<string, JsonSchema>), roles }, description);
}

const TEAM_PROPERTIES: Record<string, JsonSchema> = {
  id: text,
  parentId: nullableText,
  slug: text,
  name: text,
  description: nullableText,
  archivedAt: nullableStamp,
  deletedAt: nullableStamp,
  createdBy: nullableText,
  createdAt: stamp,
  updatedAt: stamp,
};

export const TeamsTeam = obj(Object.keys(TEAM_PROPERTIES), TEAM_PROPERTIES, 'A team');

export const TeamsTeamPage = page(TeamsTeam, 'One page of teams; total counts all of them');

const GROUP_PROPERTIES: Record<string, JsonSchema> = {
  id: text,
  teamId: text,
  parentId: { ...nullableText, description: 'the outer group' },
  slug: text,
  name: text,
  description: nullableText,
  createdBy: nullableText,
  createdAt: stamp,
  updatedAt: stamp,
};

export const TeamsGroup = obj(Object.keys(GROUP_PROPERTIES), GROUP_PROPERTIES, 'A group of a team');

export const TeamsGroupPage = page(TeamsGroup, 'One page of groups; total counts all of them');

export const TeamsMember = obj(
  ['subject', 'role', 'assignmentId', 'expiresAt'],
  { subject: { ...text, description: '`group:<id>`, `team:<id>` or `<type>:<id>` of a principal' }, role: text, assignmentId: text, expiresAt: nullableStamp },
  'One assignment at a team or group',
);

export const TeamsMemberPage = page(TeamsMember, 'One page of members; total counts all of them');

const INVITATION_PROPERTIES: Record<string, JsonSchema> = {
  id: text,
  teamId: text,
  groupId: nullableText,
  role: text,
  email: { ...nullableText, description: 'null for a shareable link' },
  maxUses: { type: 'integer', nullable: true, description: 'null for unlimited until expiry' },
  uses: { type: 'integer', minimum: 0 },
  expiresAt: stamp,
  revokedAt: nullableStamp,
  createdBy: text,
  createdAt: stamp,
  lastSentAt: nullableStamp,
};

export const TeamsInvitation = obj(Object.keys(INVITATION_PROPERTIES), INVITATION_PROPERTIES, 'An invitation; never carries its token or the token hash');

export const TeamsInvitationPage = page(TeamsInvitation, 'One page of invitations; total counts all of them');

export const TeamsInvitationCreated = obj(['invitation', 'token'], { invitation: TeamsInvitation, token: { ...text, description: 'shown once, here; the client keeps it for POST /invitations/accept' } }, 'A new invitation and its token');

export const TeamsInvitationAccepted = obj(['invitationId', 'teamId', 'groupId', 'role'], { invitationId: text, teamId: text, groupId: nullableText, role: text }, 'What the caller joined');

export const TeamsUserTeams = obj(
  ['teams', 'groups'],
  {
    teams: { type: 'array', items: withRoles(TeamsTeam, "A team of the caller with the caller's roles there") },
    groups: { type: 'array', items: withRoles(TeamsGroup, "A group of the caller with the caller's roles there") },
  },
  "The caller's teams and groups",
);

export const TeamsOk = obj(['ok'], { ok: { type: 'boolean', enum: [true] } }, 'Done');

export const TeamsError = obj(
  ['error'],
  { error: obj(['code', 'message'], { code: text, message: text, field: { ...text, description: 'the input the error is about' } }, 'The refusal') },
  "A refused request. Codes: 400 invalid_request and the AuthzAdmin validation codes (unknown_role, wrong_scope_type, not_assignable, set_cycle, set_too_deep, …); 403 forbidden, escalation, last_holder, self_lockout, protected_role, invitation_email_mismatch, invitation_not_a_user; 404 not_found, invitation_unknown; 409 conflict, invitation_expired, invitation_revoked, invitation_used_up. A refusal of the route check itself answers authz-http's `{ error: 'forbidden', permission, resource, reason }`.",
);
