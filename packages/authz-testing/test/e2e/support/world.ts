import { AccessDenied } from '@spinajs/authz';
import type { Assignment, AuthzService, Permission, Principal, ResourceType } from '@spinajs/authz';
import { fixtureDsl, userPrincipal } from '@spinajs/authz-testing';
import type { HarnessSession, OrmModelSpec, SetupContext, World } from '@spinajs/authz-testing';
import { expect } from 'chai';

import type { E2eHarness } from './stack.js';

const { combine, role } = fixtureDsl;

export const NOW = new Date('2026-10-14T12:00:00.000Z');

/**
 * org o1 > projects p1, p2 > folders (f1 > f2 > f3 under p1, f4 under p2) > tasks.
 * Tasks: t1 in f1 (alice), t2 in f2 (bob), t3 in f3 (carol), t4 in f4 (bob), t5 in f3 (alice).
 */
export const MODELS: readonly OrmModelSpec[] = [
  { name: 'Org', type: 'org', columns: [], rows: [{ id: 'o1' }] },
  { name: 'Project', type: 'project', parents: [{ column: 'org_id', type: 'org' }], columns: ['org_id'], rows: [{ id: 'p1', org_id: 'o1' }, { id: 'p2', org_id: 'o1' }] },
  {
    name: 'Folder',
    type: 'folder',
    parents: [
      { column: 'parent_id', type: 'folder', nullable: true },
      { column: 'project_id', type: 'project' },
    ],
    columns: ['parent_id', 'project_id'],
    rows: [
      { id: 'f1', parent_id: null, project_id: 'p1' },
      { id: 'f2', parent_id: 'f1', project_id: 'p1' },
      { id: 'f3', parent_id: 'f2', project_id: 'p1' },
      { id: 'f4', parent_id: null, project_id: 'p2' },
    ],
  },
  {
    name: 'Task',
    type: 'task',
    owner: 'owner_id',
    parents: [{ column: 'folder_id', type: 'folder' }],
    columns: ['folder_id', 'owner_id', 'title'],
    rows: [
      { id: 't1', folder_id: 'f1', owner_id: 'alice', title: 'a' },
      { id: 't2', folder_id: 'f2', owner_id: 'bob', title: 'b' },
      { id: 't3', folder_id: 'f3', owner_id: 'carol', title: 'c' },
      { id: 't4', folder_id: 'f4', owner_id: 'bob', title: 'd' },
      { id: 't5', folder_id: 'f3', owner_id: 'alice', title: 'e' },
    ],
  },
];

export const ROLES = [
  role('viewer', ['task:read', 'folder:read', 'project:read']),
  role('editor', ['task:read', 'task:update', 'folder:read', 'project:read']),
  role('author', [{ permission: 'task:read', relation: 'owner' }, { permission: 'task:update', relation: 'owner' }]),
  role('blocked', ['task:read', 'task:update'], { deny: true }),
  role('team.member', [], { subjectSet: true, scopeTypes: ['team'] }),
];

export const PERMISSIONS = [
  { name: 'task:read', list: true },
  { name: 'task:update', list: true },
  { name: 'folder:read', list: true },
  { name: 'project:read', list: true },
  'team:read',
  // The teams scenario grants at team and project scopes through AuthzAdmin; the stack's default covers only `authz`.
  { name: 'authz:assignments.manage', types: ['team', 'project'] },
];

export const USERS = ['alice', 'bob', 'carol', 'dave'];

export function stackWorld(assignments: readonly Assignment[] = [], extra: Partial<World> = {}): World {
  return {
    now: NOW,
    permissions: PERMISSIONS,
    principals: Object.fromEntries(USERS.map((u) => [u, userPrincipal(u)])),
    combine: combine('deny-overrides', 'rbac'),
    rbac: { roles: ROLES, assignments },
    lane: { orm: { models: MODELS } },
    ...extra,
  };
}

export async function open(harness: E2eHarness, world: World, title: string): Promise<HarnessSession> {
  return harness.setup(world, { id: 'B06', part: 'e2e', case: title, title, facets: ['engine', 'host', 'rbac', 'orm', 'admin'] } as SetupContext);
}

export const authzOf = (s: HarnessSession): AuthzService => s.authz as unknown as AuthzService;

/** `.accessible(permission)` ids as `who`, sorted; an AccessDenied is the empty list (a 403, H16). */
export async function listed(s: HarnessSession, who: Principal, permission: Permission, model = 'Task'): Promise<string[]> {
  try {
    const r = await authzOf(s).runAs(who, 'e2e', () => s.lane!.orm!.run({ op: 'select', model, accessible: permission }));
    return [...(r.ids ?? [])].sort();
  } catch (e) {
    if (e instanceof AccessDenied) return [];
    throw e;
  }
}

/** Asserts `.accessible()` returns `expected` and that `checkAll` definitely allows exactly those rows. */
export async function agrees(s: HarnessSession, who: Principal, permission: Permission, expected: readonly string[], model = 'Task', type: ResourceType = 'task'): Promise<void> {
  const ids = (await s.lane!.orm!.rows(model)).map((r) => String(r.id));
  const decisions = await authzOf(s).checkAll(who, ids.map((id) => ({ permission, resource: { type, id } })));
  const allowed = ids.filter((_, i) => decisions[i].allowed && decisions[i].residual.op === 'true').sort();
  const label = `${who.type}:${who.id} ${permission}`;
  expect(await listed(s, who, permission, model), `${label}: .accessible()`).to.deep.equal([...expected].sort());
  expect(allowed, `${label}: checkAll`).to.deep.equal([...expected].sort());
}
