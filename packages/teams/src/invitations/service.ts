import { randomUUID } from 'node:crypto';

import { AccessDenied, AuthzAdminFailure, SYSTEM, principalKey } from '@spinajs/authz';
import type { AuthzCommand, Principal, PrincipalRef } from '@spinajs/authz';
import { AssignmentStore } from '@spinajs/authz-rbac';
import { Config } from '@spinajs/configuration';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, InvalidOperation, ResourceNotFound } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { GROUP_MEMBER_ROLE, InvitationMailer, InvitationRefused, InvitationService, VerifiedEmailSource } from '../api.js';
import type { AcceptedInvitation, CreateInvitationInput, InvitationView, Page, Paged } from '../api.js';
import { assertAllowed, domainContainer, execute, teamsDriver } from '../host.js';
import { liveGroup, liveTeam } from '../lookup.js';
import type { Group } from '../models/Group.js';
import type { Team } from '../models/Team.js';
import { TeamInvitation } from '../models/TeamInvitation.js';
import { groupRef, teamRef } from '../refs.js';
import { TEAMS_DEFAULTS } from '../schema.js';
import { createdBy, reasonOf, undoOnFailure } from '../services/common.js';
import { readEmail, readId, readPage, readRole } from '../validate.js';
import { dateOf, toGroupView, toTeamView } from '../views.js';
import { INVITATION_USES_TABLE, toInvitationView } from './rows.js';
import { INVITATION_TOKEN_MAX_LENGTH, hashesEqual, invitationTokenHash, newInvitationToken, readInvitationSecret } from './token.js';

const MAX_TTL_HOURS = 24 * 365;

/** Stands in for the future member in the dry run of create(): only the role and the scope are judged. */
const PROBE: PrincipalRef = Object.freeze({ type: 'user', id: '$teams-invitation-probe' });

/** What accept() runs: the role at the team, or at the group (`group.member` through the set command). */
export function acceptCommand(member: PrincipalRef, role: string, teamId: string, groupId: string | null): AuthzCommand {
  if (groupId !== null && role === GROUP_MEMBER_ROLE) return { kind: 'set.addMember', set: { role: GROUP_MEMBER_ROLE, scope: groupRef(groupId) }, member };
  return { kind: 'assignment.grant', subject: member, role, scope: groupId !== null ? groupRef(groupId) : teamRef(teamId) };
}

/**
 * The inviter back from `created_by` (a principalKey). Only the key is stored, so the attributes, ceiling and delegation
 * of the original call are gone: the re-check judges the inviter's assignments, not the session that invited.
 */
function inviterOf(createdBy: string): Principal | null {
  const at = createdBy.indexOf(':');
  if (at <= 0) return null;
  const type = createdBy.slice(0, at).replace(/%3A/g, ':').replace(/%25/g, '%');
  const id = createdBy.slice(at + 1);
  if (type === SYSTEM.type && id === SYSTEM.id) return SYSTEM;
  return Object.freeze({ type, id, authenticated: true, source: 'invitation', attributes: Object.freeze({}) });
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

  async accept(principal: Principal, token: string): Promise<AcceptedInvitation> {
    if (!principal || principal.type !== 'user' || principal.authenticated !== true) throw new InvitationRefused('not_a_user', 'only a signed-in user accepts an invitation');
    const secret = readInvitationSecret(this.Secret);
    if (typeof token !== 'string' || token === '' || token.length > INVITATION_TOKEN_MAX_LENGTH) throw new InvitationRefused('unknown');
    const hash = invitationTokenHash(secret, token);
    const invitation = await TeamInvitation.where('token_hash', hash).first();
    if (!invitation || !hashesEqual(invitation.token_hash, hash)) throw new InvitationRefused('unknown');

    const result: AcceptedInvitation = Object.freeze({ invitationId: invitation.id, teamId: invitation.team_id, groupId: invitation.group_id ?? null, role: invitation.role });
    const who = principalKey(principal);
    if (await this.usedBy(invitation.id, who)) return result;
    if (invitation.revoked_at) throw new InvitationRefused('revoked');
    if ((dateOf(invitation.expires_at)?.getTime() ?? 0) <= Date.now()) throw new InvitationRefused('expired');
    await liveTeam(invitation.team_id).catch(() => {
      throw new InvitationRefused('unknown');
    });
    if (invitation.group_id) {
      await liveGroup(invitation.group_id).catch(() => {
        throw new InvitationRefused('unknown');
      });
    }
    if (invitation.email) {
      const verified = await (await this.emailSource()).verifiedEmail(principal);
      if (typeof verified !== 'string' || verified.trim().toLowerCase() !== invitation.email) throw new InvitationRefused('email_mismatch');
    }
    await this.assertInviterMay(invitation);

    await this.recordUse(invitation.id, who);
    const member: PrincipalRef = { type: principal.type, id: principal.id };
    await undoOnFailure(
      () => this.join(member, invitation),
      () => this.forgetUse(invitation.id, who),
    );
    return result;
  }

  protected async usedBy(invitationId: string, who: string): Promise<boolean> {
    const rows = (await (await teamsDriver()).select().from(INVITATION_USES_TABLE).where({ invitation_id: invitationId, principal: who })) as unknown[];
    return rows.length > 0;
  }

  /** The use row and the counter in one transaction; the compare-and-set keeps two accepts from both taking the last use. */
  protected async recordUse(invitationId: string, who: string): Promise<void> {
    const driver = await teamsDriver();
    await driver.transaction(async () => {
      await driver.insert().into(INVITATION_USES_TABLE).values({ invitation_id: invitationId, principal: who, used_at: new Date() });
      for (let attempt = 0; attempt < 5; attempt++) {
        const [row] = (await driver.select().from('team_invitations').where('id', invitationId)) as { uses: unknown; max_uses: unknown }[];
        const uses = Number(row.uses);
        if (row.max_uses !== null && row.max_uses !== undefined && uses >= Number(row.max_uses)) throw new InvitationRefused('used_up');
        const out = (await driver
          .update()
          .in('team_invitations')
          .update({ uses: uses + 1 })
          .where({ id: invitationId, uses })) as { RowsAffected?: number } | undefined;
        if ((out?.RowsAffected ?? 0) > 0) return;
      }
      throw new InvalidOperation(`invitation ${invitationId} is accepted by many users at once; try again`);
    });
  }

  protected async forgetUse(invitationId: string, who: string): Promise<void> {
    const driver = await teamsDriver();
    await driver.transaction(async () => {
      await driver.del().from(INVITATION_USES_TABLE).where({ invitation_id: invitationId, principal: who });
      const [row] = (await driver.select().from('team_invitations').where('id', invitationId)) as { uses: unknown }[];
      await driver
        .update()
        .in('team_invitations')
        .update({ uses: Math.max(0, Number(row.uses) - 1) })
        .where('id', invitationId);
    });
  }

  /** The grant runs as SYSTEM, so the inviter's authority is judged again as in create(): an inviter demoted since grants nothing. */
  protected async assertInviterMay(invitation: TeamInvitation): Promise<void> {
    const inviter = inviterOf(invitation.created_by);
    if (inviter === SYSTEM) return;
    if (!inviter) throw new InvitationRefused('inviter_lost_authority');
    try {
      await assertAllowed(inviter, 'team:invitations.manage', teamRef(invitation.team_id));
      await execute(inviter, [acceptCommand(PROBE, invitation.role, invitation.team_id, invitation.group_id ?? null)], `invitation:${invitation.id}`, { dryRun: true });
    } catch (e) {
      if (e instanceof AccessDenied || (e instanceof AuthzAdminFailure && (e.code === 'escalation' || e.code === 'forbidden'))) throw new InvitationRefused('inviter_lost_authority');
      throw e;
    }
  }

  /** Teams design §8: as SYSTEM, reason `invitation:<id>`; a role already held at the scope is not granted twice. */
  protected async join(member: PrincipalRef, invitation: TeamInvitation): Promise<void> {
    const scope = invitation.group_id ? groupRef(invitation.group_id) : teamRef(invitation.team_id);
    const container = await domainContainer();
    if (container.hasRegistered(AssignmentStore)) {
      const held = await ((await container.resolve(AssignmentStore)) as AssignmentStore).forSubjects([member], new Date());
      if (held.some((a) => a.role === invitation.role && a.scope.type === scope.type && a.scope.id === scope.id)) return;
    }
    await execute(SYSTEM, [acceptCommand(member, invitation.role, invitation.team_id, invitation.group_id ?? null)], `invitation:${invitation.id}`);
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
