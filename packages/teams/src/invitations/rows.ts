import type { InvitationView } from '../api.js';
import { teamsDriver } from '../host.js';
import { TeamInvitation } from '../models/TeamInvitation.js';
import { dateOf } from '../views.js';

export const INVITATION_USES_TABLE = 'team_invitation_uses';

export function toInvitationView(i: TeamInvitation): InvitationView {
  return Object.freeze({
    id: i.id,
    teamId: i.team_id,
    groupId: i.group_id ?? null,
    role: i.role,
    email: i.email ?? null,
    maxUses: i.max_uses ?? null,
    uses: Number(i.uses ?? 0),
    expiresAt: dateOf(i.expires_at)!,
    revokedAt: dateOf(i.revoked_at),
    createdBy: i.created_by,
    createdAt: dateOf(i.created_at)!,
    lastSentAt: dateOf(i.last_sent_at),
  });
}

/** Invitations (and their uses) of a team or a group, before the team or group row goes. */
export async function deleteInvitations(where: { readonly team_id: string } | { readonly group_id: string }): Promise<void> {
  const ids = ((await TeamInvitation.query().where(where)) as TeamInvitation[]).map((i) => i.id);
  if (ids.length === 0) return;
  await (await teamsDriver()).del().from(INVITATION_USES_TABLE).whereIn('invitation_id', ids);
  await TeamInvitation.destroy(ids);
}
