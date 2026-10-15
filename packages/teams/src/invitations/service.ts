import { randomUUID } from 'node:crypto';

import type { AuthzCommand, Principal, PrincipalRef } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, MethodNotImplemented, ResourceNotFound } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { GROUP_MEMBER_ROLE, InvitationMailer, InvitationService, VerifiedEmailSource } from '../api.js';
import type { AcceptedInvitation, CreateInvitationInput, InvitationView, Page, Paged } from '../api.js';
import { assertAllowed, domainContainer, execute } from '../host.js';
import { liveGroup, liveTeam } from '../lookup.js';
import type { Group } from '../models/Group.js';
import type { Team } from '../models/Team.js';
import { TeamInvitation } from '../models/TeamInvitation.js';
import { groupRef, teamRef } from '../refs.js';
import { TEAMS_DEFAULTS } from '../schema.js';
import { createdBy, reasonOf, undoOnFailure } from '../services/common.js';
import { readEmail, readId, readPage, readRole } from '../validate.js';
import { dateOf, toGroupView, toTeamView } from '../views.js';
import { toInvitationView } from './rows.js';
import { invitationTokenHash, newInvitationToken, readInvitationSecret } from './token.js';

const MAX_TTL_HOURS = 24 * 365;

/** Stands in for the future member in the dry run of create(): only the role and the scope are judged. */
const PROBE: PrincipalRef = Object.freeze({ type: 'user', id: '$teams-invitation-probe' });

/** What accept() runs: the role at the team, or at the group (`group.member` through the set command). */
export function acceptCommand(member: PrincipalRef, role: string, teamId: string, groupId: string | null): AuthzCommand {
  if (groupId !== null && role === GROUP_MEMBER_ROLE) return { kind: 'set.addMember', set: { role: GROUP_MEMBER_ROLE, scope: groupRef(groupId) }, member };
  return { kind: 'assignment.grant', subject: member, role, scope: groupId !== null ? groupRef(groupId) : teamRef(teamId) };
}

function readMaxUses(v: unknown, email: string | null): number | null {
  if (v === undefined) return email ? 1 : null;
  if (v === null) return null;
  if (!Number.isInteger(v) || (v as number) < 1) throw new InvalidArgument('maxUses: must be an integer of at least 1, or null', 'maxUses');
  return v as number;
}

function readHours(v: unknown): number {
  if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > MAX_TTL_HOURS) throw new InvalidArgument(`expiresInHours: must be an integer from 1 to ${MAX_TTL_HOURS}`, 'expiresInHours');
  return v as number;
}

@Singleton()
@Injectable(InvitationService)
export class DefaultInvitationService extends InvitationService {
  @Config('teams.invitations.secret')
  protected Secret: string | undefined;

  @Config('teams.invitations.defaultTtlHours', { defaultValue: TEAMS_DEFAULTS.defaultTtlHours })
  protected DefaultTtlHours: number;

  async create(actor: Principal, input: CreateInvitationInput): Promise<{ readonly invitation: InvitationView; readonly token: string }> {
    const team = await liveTeam(input?.teamId);
    const group = input?.groupId == null ? null : await liveGroup(input.groupId);
    if (group && group.team_id !== team.id) throw new InvalidArgument('groupId: the group belongs to another team', 'groupId');
    const role = readRole(input?.role);
    const email = input?.email == null ? null : readEmail(input.email);
    const maxUses = readMaxUses(input?.maxUses, email);
    const hours = readHours(input?.expiresInHours ?? this.DefaultTtlHours);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    // Fail before anything is written: an email invitation nobody can accept is useless.
    if (email) await this.emailSource();
    // No escalation through invitations: AuthzAdmin's permission check and the guard judge the accept command as the inviter's own.
    await execute(actor, [acceptCommand(PROBE, role, team.id, group?.id ?? null)], reasonOf('invite', actor), { dryRun: true });

    const secret = readInvitationSecret(this.Secret);
    const token = newInvitationToken();
    const now = DateTime.now();
    const invitation = new TeamInvitation({ id: randomUUID(), team_id: team.id, group_id: group?.id ?? null, role, email, token_hash: invitationTokenHash(secret, token), max_uses: maxUses, uses: 0, expires_at: now.plus({ hours }), revoked_at: null, created_by: createdBy(actor), created_at: now, last_sent_at: null });
    await invitation.insert();
    if (email) {
      await undoOnFailure(
        () => this.mail(actor, invitation, team, group, token),
        () => invitation.destroy(),
      );
    }
    return Object.freeze({ invitation: toInvitationView(invitation), token });
  }

  async list(actor: Principal, teamId: string, page?: Page): Promise<Paged<InvitationView>> {
    const team = await liveTeam(teamId);
    const p = readPage(page);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    const total = await TeamInvitation.query().where('team_id', team.id).selectCount();
    const rows = (await TeamInvitation.query().where('team_id', team.id).orderBy('created_at').skip(p.offset).take(p.limit)) as TeamInvitation[];
    return Object.freeze({ items: Object.freeze(rows.map(toInvitationView)), total: Number(total) });
  }

  async revoke(actor: Principal, teamId: string, id: string): Promise<void> {
    const team = await liveTeam(teamId);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    const invitation = await this.invitation(team.id, id);
    if (!invitation.revoked_at) await invitation.update({ revoked_at: DateTime.now() });
  }

  async resend(actor: Principal, teamId: string, id: string): Promise<InvitationView> {
    const team = await liveTeam(teamId);
    await assertAllowed(actor, 'team:invitations.manage', teamRef(team.id));
    const invitation = await this.invitation(team.id, id);
    const group = invitation.group_id ? await liveGroup(invitation.group_id) : null;
    if (!invitation.email) throw new InvalidArgument('id: a link invitation has no address to mail', 'id');
    if (invitation.revoked_at || (dateOf(invitation.expires_at)?.getTime() ?? 0) <= Date.now()) throw new InvalidOperation(`invitation ${invitation.id} is revoked or expired`);
    // Only the hash is stored, so the mail carries a new token and the old one stops working.
    const secret = readInvitationSecret(this.Secret);
    const token = newInvitationToken();
    const previous = invitation.token_hash;
    await invitation.update({ token_hash: invitationTokenHash(secret, token) });
    await undoOnFailure(
      () => this.mail(actor, invitation, team, group, token),
      () => invitation.update({ token_hash: previous }),
    );
    return toInvitationView(await this.invitation(team.id, invitation.id));
  }

  async accept(_principal: Principal, _token: string): Promise<AcceptedInvitation> {
    throw new MethodNotImplemented('DefaultInvitationService.accept: lane L14 Task 10');
  }

  /** Teams ships no VerifiedEmailSource (Principal carries no verified email); the app registers one. */
  protected async emailSource(): Promise<VerifiedEmailSource> {
    const container = await domainContainer();
    if (!container.hasRegistered(VerifiedEmailSource)) {
      throw new InvalidOperation("@spinajs/teams: email invitations need a VerifiedEmailSource; register one that returns the principal's verified address");
    }
    return (await container.resolve(VerifiedEmailSource)) as VerifiedEmailSource;
  }

  /** Another team's invitation is reported as missing, so an id says nothing about other teams. */
  protected async invitation(teamId: string, id: unknown): Promise<TeamInvitation> {
    const key = readId(id, 'id');
    const row = await TeamInvitation.where('id', key).first();
    if (!row || row.team_id !== teamId) throw new ResourceNotFound(`invitation ${key} does not exist in team ${teamId}`);
    return row;
  }

  protected async mail(actor: Principal, invitation: TeamInvitation, team: Team, group: Group | null, token: string): Promise<void> {
    const mailer = (await DI.resolve(InvitationMailer)) as InvitationMailer;
    await mailer.send({ to: invitation.email!, team: toTeamView(team), group: group ? toGroupView(group) : null, role: invitation.role, token, expiresAt: dateOf(invitation.expires_at)!, invitedBy: { type: actor.type, id: actor.id } });
    await invitation.update({ last_sent_at: DateTime.now() });
  }
}
