import { InvalidArgument, ResourceNotFound } from '@spinajs/exceptions';

import { asSystem } from './host.js';
import { Group } from './models/Group.js';
import { Team } from './models/Team.js';
import { readId } from './validate.js';

/** A team row, deleted or not. */
export async function anyTeam(id: unknown, field = 'teamId'): Promise<Team> {
  const key = readId(id, field);
  const team = await asSystem(() => Team.where('id', key).first());
  if (!team) throw new ResourceNotFound(`team ${key} does not exist`);
  return team;
}

export async function liveTeam(id: unknown, field = 'teamId'): Promise<Team> {
  const team = await anyTeam(id, field);
  if (team.deleted_at) throw new ResourceNotFound(`team ${team.id} does not exist`);
  return team;
}

/** A group of a live team. */
export async function liveGroup(id: unknown, field = 'groupId'): Promise<Group> {
  const key = readId(id, field);
  const group = await asSystem(() => Group.where('id', key).first());
  if (!group) throw new ResourceNotFound(`group ${key} does not exist`);
  await liveTeam(group.team_id).catch(() => {
    throw new ResourceNotFound(`group ${key} does not exist`);
  });
  return group;
}

/** Teams design §6: a group's parent group must belong to the same team. */
export async function groupParent(teamId: string, parentId: unknown): Promise<Group> {
  const parent = await liveGroup(parentId, 'parentId').catch(() => {
    throw new InvalidArgument('parentId: no such group', 'parentId');
  });
  if (parent.team_id !== teamId) throw new InvalidArgument('parentId: the parent group belongs to another team', 'parentId');
  return parent;
}

async function lineage(id: string, load: (id: string) => Promise<{ parent_id: string | null } | undefined>): Promise<string[]> {
  const out: string[] = [];
  let next: string | null = id;
  while (next !== null && !out.includes(next)) {
    out.push(next);
    next = (await load(next))?.parent_id ?? null;
  }
  return out;
}

/** The team and its ancestors, nearest first. */
export function teamLineage(id: string): Promise<string[]> {
  return lineage(id, (k) => asSystem(() => Team.where('id', k).first()));
}

/** The group and its ancestor groups, nearest first. */
export function groupLineage(id: string): Promise<string[]> {
  return lineage(id, (k) => asSystem(() => Group.where('id', k).first()));
}
