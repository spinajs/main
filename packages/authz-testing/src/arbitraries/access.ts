import * as fc from 'fast-check';

import { GLOBAL } from '@spinajs/authz';
import type { Assignment, ResourceRef } from '@spinajs/authz';

import type { OrmModelSpec } from '../behaviour/lane.js';
import type { World } from '../behaviour/types.js';
import type { FakePermissionInput } from '../registry.js';
import { userPrincipal } from '../principals.js';
import type { TestRoleDef } from './rbac.js';

export const ACCESS_PERMISSIONS: readonly FakePermissionInput[] = Object.freeze([
  { name: 'doc:read', list: true },
  { name: 'doc:update', list: true },
  { name: 'project:read', list: true },
]);

const role = (name: string, grants: TestRoleDef['grants'], extra: Partial<TestRoleDef> = {}): TestRoleDef => ({ name, extends: [], assignable: true, source: 'test', grants, ...extra });

/** viewer < editor by grants; author reads its own docs; blocked denies reading at its scope and below. */
export const ACCESS_ROLES: Readonly<Record<string, TestRoleDef>> = Object.freeze({
  viewer: role('viewer', [{ permission: 'doc:read' }, { permission: 'project:read' }]),
  editor: role('editor', [{ permission: 'doc:read' }, { permission: 'doc:update' }, { permission: 'project:read' }]),
  author: role('author', [
    { permission: 'doc:read', relation: 'owner' },
    { permission: 'doc:update', relation: 'owner' },
  ]),
  blocked: role('blocked', [{ permission: 'doc:read' }], { deny: true }),
});

const MODELS = Object.freeze({ org: 'Org', project: 'Project', doc: 'Doc' } as const);

export interface AccessWorld {
  readonly world: World;
  /** User ids of `world.principals`. */
  readonly users: readonly string[];
  /** Names of the models in `world.lane.orm`. */
  readonly models: typeof MODELS;
}

export interface AccessWorldOptions {
  readonly now?: Date;
  readonly maxDocs?: number;
}

const USERS = ['alice', 'bob', 'carol'] as const;

/**
 * Random org > project > doc data (`@Parent` chains, `@Owner` on docs) and RBAC assignments of ACCESS_ROLES at
 * $global, org, project or doc scope, to a user or to `user:*`, live, expired or expiring later. Combined
 * deny-overrides over the model 'rbac'. B06 over the ORM holds for every such world.
 */
export function accessWorld(opts: AccessWorldOptions = {}): fc.Arbitrary<AccessWorld> {
  const now = opts.now ?? new Date('2026-10-14T12:00:00.000Z');
  const past = new Date(now.getTime() - 3_600_000);
  const later = new Date(now.getTime() + 3_600_000);
  const shape = fc.record({
    projects: fc.array(fc.constantFrom('o1', 'o2'), { minLength: 1, maxLength: 3 }),
    docs: fc.array(fc.record({ project: fc.nat(), owner: fc.constantFrom(...USERS) }), { maxLength: opts.maxDocs ?? 6 }),
  });
  return shape.chain(({ projects, docs }) => {
    const projectIds = projects.map((_, i) => `p${i + 1}`);
    const docRows = docs.map((d, i) => ({ id: `d${i + 1}`, project_id: projectIds[d.project % projectIds.length], owner: d.owner }));
    const scopes: ResourceRef[] = [GLOBAL, { type: 'org', id: 'o1' }, { type: 'org', id: 'o2' }, ...projectIds.map((id) => ({ type: 'project', id })), ...docRows.map((d) => ({ type: 'doc', id: d.id }))];
    const grant = fc.record({
      subject: fc.constantFrom<string>(...USERS, '*'),
      role: fc.constantFrom(...Object.keys(ACCESS_ROLES)),
      scope: fc.constantFrom(...scopes),
      expires: fc.constantFrom<'never' | 'past' | 'later'>('never', 'never', 'past', 'later'),
    });
    return fc.array(grant, { maxLength: 8 }).map((grants): AccessWorld => {
      const assignments: Assignment[] = grants.map((g, i) => ({
        id: `a${i + 1}`,
        subject: { type: 'user', id: g.subject },
        role: g.role,
        scope: g.scope,
        source: 'test',
        ...(g.expires === 'never' ? {} : { expiresAt: g.expires === 'past' ? past : later }),
      }));
      const models: OrmModelSpec[] = [
        { name: MODELS.org, type: 'org', columns: [], rows: [{ id: 'o1' }, { id: 'o2' }] },
        { name: MODELS.project, type: 'project', parents: [{ column: 'org_id', type: 'org' }], columns: ['org_id'], rows: projects.map((org, i) => ({ id: projectIds[i], org_id: org })) },
        { name: MODELS.doc, type: 'doc', owner: 'owner', parents: [{ column: 'project_id', type: 'project' }], columns: ['project_id', 'owner'], rows: docRows },
      ];
      return {
        users: USERS,
        models: MODELS,
        world: {
          now,
          permissions: ACCESS_PERMISSIONS,
          principals: Object.fromEntries(USERS.map((u) => [u, userPrincipal(u)])),
          combine: { default: { algorithm: 'deny-overrides', models: ['rbac'] } },
          rbac: { roles: Object.values(ACCESS_ROLES), assignments },
          lane: { orm: { models } },
        },
      };
    });
  });
}
