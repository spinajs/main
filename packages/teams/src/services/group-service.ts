import { randomUUID } from 'node:crypto';

import { SYSTEM } from '@spinajs/authz';
import type { AuthzCommand, Principal } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { DateTime } from 'luxon';

import { GROUP_MEMBER_ROLE, GroupService } from '../api.js';
import type { CreateGroupInput, GroupView, MemberEntry, MoveGroupInput, Page, Paged, TeamSubject, UpdateGroupInput } from '../api.js';
import { asSystem, assertAllowed, execute, teamsDriver } from '../host.js';
import { groupLineage, groupParent, liveGroup, liveTeam } from '../lookup.js';
import { Group } from '../models/Group.js';
import { groupRef, teamRef } from '../refs.js';
import { assertSubjectExists, readSubject, toAssignmentSubject } from '../subjects.js';
import { readDescription, readName, readPage, readSlug } from '../validate.js';
import { toGroupView } from '../views.js';
import { createdBy, pageOf, reasonOf, undoOnFailure } from './common.js';
import { linkGroup, unlinkGroup } from './links.js';
import { listMembers } from './members.js';

@Singleton()
@Injectable(GroupService)
export class DefaultGroupService extends GroupService {
  async createGroup(actor: Principal, teamId: string, input: CreateGroupInput): Promise<GroupView> {
    const team = await liveTeam(teamId);
    const slug = readSlug(input?.slug);
    const name = readName(input?.name);
    const description = readDescription(input?.description);
    const parent = input?.parentId == null ? null : await groupParent(team.id, input.parentId);
    await assertAllowed(actor, 'group:create', teamRef(team.id));
    await this.assertSlugFree(team.id, [slug]);

    const now = DateTime.now();
    const group = new Group({ id: randomUUID(), team_id: team.id, parent_id: parent?.id ?? null, slug, name, description, created_by: createdBy(actor), created_at: now, updated_at: now });
    // Authz first (lane decision 12): a crash after it leaves an inert link, never a group outside its team's set.
    await execute(SYSTEM, [linkGroup(group)], reasonOf('create-group', actor));
    await undoOnFailure(
      () => asSystem(() => group.insert()),
      () => execute(SYSTEM, [unlinkGroup(group)], reasonOf('create-group-undo', actor)),
    );
    return toGroupView(group);
  }

  async getGroup(actor: Principal, id: string): Promise<GroupView> {
    const group = await liveGroup(id, 'id');
    await assertAllowed(actor, 'group:read', groupRef(group.id));
    return toGroupView(group);
  }

  async listGroups(actor: Principal, teamId: string, page?: Page): Promise<Paged<GroupView>> {
    const team = await liveTeam(teamId);
    return pageOf(
      actor,
      readPage(page),
      () => Group.query().accessible('group:read').within(teamRef(team.id)),
      (g: Group) => toGroupView(g),
    );
  }

  async updateGroup(actor: Principal, id: string, input: UpdateGroupInput): Promise<GroupView> {
    const group = await liveGroup(id, 'id');
    await assertAllowed(actor, 'group:update', groupRef(group.id));
    const changes: Partial<Group> = {};
    if (input?.slug !== undefined) {
      const slug = readSlug(input.slug);
      if (slug !== group.slug) {
        await this.assertSlugFree(group.team_id, [slug]);
        changes.slug = slug;
      }
    }
    if (input?.name !== undefined) changes.name = readName(input.name);
    if (input?.description !== undefined) changes.description = readDescription(input.description);
    if (Object.keys(changes).length > 0) await asSystem(() => group.update({ ...changes, updated_at: DateTime.now() }));
    return toGroupView(await liveGroup(group.id));
  }

  async moveGroup(actor: Principal, id: string, to: MoveGroupInput): Promise<GroupView> {
    const group = await liveGroup(id, 'id');
    const target = await liveTeam(to?.teamId ?? group.team_id);
    const parent = to?.parentId == null ? null : await groupParent(target.id, to.parentId);
    await assertAllowed(actor, 'group:update', groupRef(group.id));
    const crossTeam = target.id !== group.team_id;
    if (crossTeam) await assertAllowed(actor, 'group:create', teamRef(target.id));
    if ((parent?.id ?? null) === (group.parent_id ?? null) && !crossTeam) return toGroupView(group);
    if (parent && (await groupLineage(parent.id)).includes(group.id)) throw new InvalidArgument('parentId: a group cannot move below itself', 'parentId');

    const subtree = crossTeam ? await this.subtree(group) : [group];
    if (crossTeam)
      await this.assertSlugFree(
        target.id,
        subtree.map((g) => g.slug),
      );
    const before = { team_id: group.team_id, parent_id: group.parent_id ?? null };
    const after = { team_id: target.id, parent_id: parent?.id ?? null };

    const driver = await teamsDriver();
    // Both @Parent columns in one transaction: authz-orm rewrites the closure of every moved row.
    const write = (from: typeof before, next: typeof after) =>
      asSystem(() =>
        driver.transaction(async () => {
          if (from.team_id !== next.team_id)
            await Group.update({ team_id: next.team_id }).whereIn(
              'id',
              subtree.map((g) => g.id),
            );
          await Group.update({ parent_id: next.parent_id }).where('id', group.id);
        }),
      );
    await write(before, after);
    const commands: AuthzCommand[] = [unlinkGroup({ id: group.id, ...before }), linkGroup({ id: group.id, ...after })];
    await undoOnFailure(
      () => execute(SYSTEM, commands, reasonOf('move-group', actor)),
      () => write(after, before),
    );
    return toGroupView(await liveGroup(group.id));
  }

  async deleteGroup(actor: Principal, id: string): Promise<void> {
    const group = await liveGroup(id, 'id');
    await assertAllowed(actor, 'group:delete', groupRef(group.id));
    if (await asSystem(() => Group.where('parent_id', group.id).first())) throw new InvalidArgument('id: the group has sub-groups; move or delete them first', 'id');
    await this.beforeDelete(group);
    // authz-orm's delete clean-up forgets the group scope in the same statement's transaction.
    await asSystem(() => group.destroy());
  }

  async members(actor: Principal, groupId: string, page?: Page): Promise<Paged<MemberEntry>> {
    const group = await liveGroup(groupId);
    await assertAllowed(actor, 'group:read', groupRef(group.id));
    return listMembers(actor, groupRef(group.id), page);
  }

  async addGroupMember(actor: Principal, groupId: string, subject: TeamSubject): Promise<void> {
    const group = await liveGroup(groupId);
    const s = readSubject(subject);
    if ('group' in s && s.group === group.id) throw new InvalidArgument('subject: a group cannot be its own member', 'subject');
    await assertSubjectExists(s);
    await assertAllowed(actor, 'group:members.manage', groupRef(group.id));
    const set = { role: GROUP_MEMBER_ROLE, scope: groupRef(group.id) };
    if ('group' in s || 'team' in s) {
      await execute(SYSTEM, [{ kind: 'assignment.grant', subject: toAssignmentSubject(s), role: GROUP_MEMBER_ROLE, scope: set.scope }], reasonOf('add-group-member', actor));
      return;
    }
    await execute(actor, [{ kind: 'set.addMember', set, member: s }], reasonOf('add-group-member', actor));
  }

  async removeGroupMember(actor: Principal, groupId: string, subject: TeamSubject): Promise<void> {
    const group = await liveGroup(groupId);
    const s = readSubject(subject);
    await assertAllowed(actor, 'group:members.manage', groupRef(group.id));
    const set = { role: GROUP_MEMBER_ROLE, scope: groupRef(group.id) };
    if ('group' in s || 'team' in s) {
      if ('group' in s) {
        const child = await asSystem(() => Group.where('id', s.group).first());
        if (child && child.parent_id === group.id) throw new InvalidArgument('subject: a sub-group is a member through the group structure; move it instead', 'subject');
      }
      await execute(SYSTEM, [{ kind: 'assignment.revokeWhere', scope: set.scope, subject: toAssignmentSubject(s), role: GROUP_MEMBER_ROLE }], reasonOf('remove-group-member', actor));
      return;
    }
    await execute(actor, [{ kind: 'set.removeMember', set, member: s }], reasonOf('remove-group-member', actor));
  }

  /** Rows that reference the group and are not authz data; Task 9 deletes its invitations here. */
  protected async beforeDelete(_group: Group): Promise<void> {}

  protected async assertSlugFree(teamId: string, slugs: readonly string[]): Promise<void> {
    if (slugs.length === 0) return;
    const taken = await asSystem(
      async () =>
        (await Group.query()
          .where('team_id', teamId)
          .whereIn('slug', [...slugs])) as Group[],
    );
    if (taken.length > 0) throw new ResourceDuplicated(`group slug ${taken[0].slug} is taken in team ${teamId}`);
  }

  /** The group and every group below it. */
  protected async subtree(group: Group): Promise<Group[]> {
    const all = await asSystem(async () => (await Group.query().where('team_id', group.team_id)) as Group[]);
    const out = [group];
    for (let i = 0; i < out.length; i++) out.push(...all.filter((g) => g.parent_id === out[i].id));
    return out;
  }
}
