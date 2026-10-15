import { randomUUID } from 'node:crypto';

import { GLOBAL, SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Principal, PrincipalRef, ResourceRef } from '@spinajs/authz';
import { Config } from '@spinajs/configuration';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, MethodNotImplemented, ResourceDuplicated } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { TEAM_OWNER_ROLE, TeamService } from '../api.js';
import type { CreateTeamInput, MemberEntry, Page, Paged, PrincipalTeams, TeamSubject, TeamView, UpdateTeamInput } from '../api.js';
import { asSystem, assertAllowed, execute } from '../host.js';
import { liveTeam, teamLineage } from '../lookup.js';
import { principalTeams } from '../membership.js';
import { Team } from '../models/Team.js';
import { teamRef } from '../refs.js';
import { readDescription, readId, readName, readPage, readSlug } from '../validate.js';
import { toTeamView } from '../views.js';
import { createdBy, ownerOf, pageOf, reasonOf, undoOnFailure } from './common.js';
import { archivedAttribute, linkSubTeam, unlinkSubTeam } from './links.js';

@Singleton()
@Injectable(TeamService)
export class DefaultTeamService extends TeamService {
  @Config('teams.membership.subTeamsInParent', { defaultValue: true })
  protected SubTeamsInParent: boolean;

  @Config('teams.deletion.graceDays', { defaultValue: 30 })
  protected GraceDays: number;

  async createTeam(actor: Principal, input: CreateTeamInput): Promise<TeamView> {
    const slug = readSlug(input?.slug);
    const name = readName(input?.name);
    const description = readDescription(input?.description);
    const owner = ownerOf(actor, input?.owner);
    const parent = input?.parentId == null ? null : await liveTeam(input.parentId, 'parentId');
    await assertAllowed(actor, 'team:create', parent ? teamRef(parent.id) : GLOBAL);
    await this.assertSlugFree(slug);

    const now = DateTime.now();
    const team = new Team({ id: randomUUID(), parent_id: parent?.id ?? null, slug, name, description, archived_at: null, deleted_at: null, created_by: createdBy(actor), created_at: now, updated_at: now });
    const scope = teamRef(team.id);
    const linkTo = parent && this.SubTeamsInParent ? parent.id : null;
    // Authz first (lane decision 12): a crash after it leaves inert assignments, never a team without an owner.
    // SYSTEM: the actor holds nothing on the new team yet; it passed team:create above.
    const commands: AuthzCommand[] = [{ kind: 'assignment.grant', subject: owner, role: TEAM_OWNER_ROLE, scope }, archivedAttribute(team.id, false)];
    if (linkTo) commands.push(linkSubTeam(team.id, linkTo));
    await execute(SYSTEM, commands, reasonOf('create', actor));
    await undoOnFailure(
      () => asSystem(() => team.insert()),
      () => execute(SYSTEM, [{ kind: 'assignment.revokeWhere', scope, subject: owner, role: TEAM_OWNER_ROLE }, { kind: 'scope.setAttributes', scope, patch: { archived: null } }, ...(linkTo ? [unlinkSubTeam(team.id, linkTo)] : [])], reasonOf('create-undo', actor)),
    );
    return toTeamView(team);
  }

  async getTeam(actor: Principal, id: string): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    await assertAllowed(actor, 'team:read', teamRef(team.id));
    return toTeamView(team);
  }

  async listTeams(actor: Principal, opts: { readonly parentId?: string | null; readonly page?: Page } = {}): Promise<Paged<TeamView>> {
    const parentId = opts.parentId === undefined || opts.parentId === null ? opts.parentId : readId(opts.parentId, 'parentId');
    const query = () => {
      let q = Team.query().accessible('team:read').whereNull('deleted_at');
      if (parentId === null) q = q.whereNull('parent_id');
      else if (parentId !== undefined) q = q.where('parent_id', parentId);
      return q;
    };
    return pageOf(actor, readPage(opts.page), query, (t: Team) => toTeamView(t));
  }

  async updateTeam(actor: Principal, id: string, input: UpdateTeamInput): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    await assertAllowed(actor, 'team:update', teamRef(team.id));
    const changes: Partial<Team> = {};
    if (input?.slug !== undefined) {
      const slug = readSlug(input.slug);
      if (slug !== team.slug) {
        await this.assertSlugFree(slug);
        changes.slug = slug;
      }
    }
    if (input?.name !== undefined) changes.name = readName(input.name);
    if (input?.description !== undefined) changes.description = readDescription(input.description);
    if (Object.keys(changes).length > 0) await asSystem(() => team.update({ ...changes, updated_at: DateTime.now() }));
    return toTeamView(await liveTeam(team.id));
  }

  async moveTeam(actor: Principal, id: string, parentId: string | null): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    const parent = parentId === null ? null : await liveTeam(parentId, 'parentId');
    await assertAllowed(actor, 'team:update', teamRef(team.id));
    await assertAllowed(actor, 'team:create', parent ? teamRef(parent.id) : GLOBAL);
    const from = team.parent_id ?? null;
    const to = parent?.id ?? null;
    if (from === to) return toTeamView(team);
    if (to !== null && (await teamLineage(to)).includes(team.id)) throw new InvalidArgument('parentId: a team cannot move below itself', 'parentId');

    // A @Parent update: authz-orm rewrites the closure of the team and everything below it.
    await asSystem(() => team.update({ parent_id: to, updated_at: DateTime.now() }));
    const commands: AuthzCommand[] = [...(from ? [unlinkSubTeam(team.id, from)] : []), ...(to && this.SubTeamsInParent ? [linkSubTeam(team.id, to)] : [])];
    await undoOnFailure(
      () => execute(SYSTEM, commands, reasonOf('move', actor)),
      () => asSystem(() => team.update({ parent_id: from })),
    );
    return toTeamView(await liveTeam(team.id));
  }

  async archiveTeam(actor: Principal, id: string): Promise<TeamView> {
    return this.setArchived(actor, id, true);
  }

  async unarchiveTeam(actor: Principal, id: string): Promise<TeamView> {
    return this.setArchived(actor, id, false);
  }

  async teamsOf(principal: PrincipalRef): Promise<PrincipalTeams> {
    return principalTeams({ type: principal.type, id: principal.id });
  }

  // ---- Task 6 ----

  async members(_actor: Principal, _teamId: string, _page?: Page): Promise<Paged<MemberEntry>> {
    throw new MethodNotImplemented('DefaultTeamService.members: lane L14 Task 6');
  }

  async addTeamMember(_actor: Principal, _teamId: string, _subject: TeamSubject, _role?: string): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.addTeamMember: lane L14 Task 6');
  }

  async removeTeamMember(_actor: Principal, _teamId: string, _subject: TeamSubject): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.removeTeamMember: lane L14 Task 6');
  }

  async setTeamRole(_actor: Principal, _teamId: string, _subject: TeamSubject, _role: string): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.setTeamRole: lane L14 Task 6');
  }

  async transferOwnership(_actor: Principal, _teamId: string, _to: PrincipalRef, _opts?: { readonly keepAs?: string | null }): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.transferOwnership: lane L14 Task 6');
  }

  async grant(_actor: Principal, _subject: TeamSubject, _role: string, _scope: ResourceRef): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.grant: lane L14 Task 6');
  }

  async revoke(_actor: Principal, _subject: TeamSubject, _role: string, _scope: ResourceRef): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.revoke: lane L14 Task 6');
  }

  // ---- Task 8 ----

  async deleteTeam(_actor: Principal, _id: string): Promise<void> {
    throw new MethodNotImplemented('DefaultTeamService.deleteTeam: lane L14 Task 8');
  }

  async restoreTeam(_actor: Principal, _id: string): Promise<TeamView> {
    throw new MethodNotImplemented('DefaultTeamService.restoreTeam: lane L14 Task 8');
  }

  async purgeTeam(_actor: Principal, _id: string): Promise<readonly string[]> {
    throw new MethodNotImplemented('DefaultTeamService.purgeTeam: lane L14 Task 8');
  }

  async purgeDue(_now?: Date): Promise<readonly string[]> {
    throw new MethodNotImplemented('DefaultTeamService.purgeDue: lane L14 Task 8');
  }

  // ---- helpers ----

  protected async assertSlugFree(slug: string): Promise<void> {
    // Deleted teams keep their slug until they are purged.
    if (await asSystem(() => Team.where('slug', slug).first())) throw new ResourceDuplicated(`team slug ${slug} is taken`);
  }

  protected async setArchived(actor: Principal, id: string, archived: boolean): Promise<TeamView> {
    const team = await liveTeam(id, 'id');
    await assertAllowed(actor, 'team:archive', teamRef(team.id));
    if ((team.archived_at !== null && team.archived_at !== undefined) === archived) return toTeamView(team);
    const before = team.archived_at ?? null;
    await asSystem(() => team.update({ archived_at: archived ? DateTime.now() : null, updated_at: DateTime.now() }));
    await undoOnFailure(
      () => execute(SYSTEM, [archivedAttribute(team.id, archived)], reasonOf(archived ? 'archive' : 'unarchive', actor)),
      () => asSystem(() => team.update({ archived_at: before })),
    );
    return toTeamView(await liveTeam(team.id));
  }
}
