import { DateTime } from 'luxon';

import type { GroupView, TeamView } from './api.js';
import type { Group } from './models/Group.js';
import type { Team } from './models/Team.js';

export function dateOf(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof DateTime) return v.toJSDate();
  if (v instanceof Date) return v;
  return new Date(String(v));
}

export function toTeamView(t: Team): TeamView {
  return Object.freeze({
    id: t.id,
    parentId: t.parent_id ?? null,
    slug: t.slug,
    name: t.name,
    description: t.description ?? null,
    archivedAt: dateOf(t.archived_at),
    deletedAt: dateOf(t.deleted_at),
    createdBy: t.created_by ?? null,
    createdAt: dateOf(t.created_at)!,
    updatedAt: dateOf(t.updated_at)!,
  });
}

export function toGroupView(g: Group): GroupView {
  return Object.freeze({
    id: g.id,
    teamId: g.team_id,
    parentId: g.parent_id ?? null,
    slug: g.slug,
    name: g.name,
    description: g.description ?? null,
    createdBy: g.created_by ?? null,
    createdAt: dateOf(g.created_at)!,
    updatedAt: dateOf(g.updated_at)!,
  });
}
