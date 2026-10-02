import { userPrincipal } from '../principals.js';
import { combine, extension, permit, staticModel } from './dsl.js';
import { as, fsCall } from './lane.js';
import type { World } from './types.js';

const DENIED = { throws: 'AccessDenied' } as const;

/**
 * uploads names the domain 'fs' (design §13): FsInheritModel ('fs-inherit') permits fs:<op> on a file
 * when the principal holds `<parent type>:<mapped op>` on the domain parent from the FsPathResolver.
 * Root m1 holds the task permissions: alice may read task 42, carol may also update it.
 */
const world: World = {
  permissions: ['task:read', 'task:update'],
  principals: { alice: userPrincipal('alice'), bob: userPrincipal('bob'), carol: userPrincipal('carol') },
  combine: combine('deny-overrides', 'm1'),
  models: [
    staticModel('m1', {
      votes: (req) => {
        if (req.resource.type !== 'task' || req.resource.id !== '42') return {};
        if (req.permission === 'task:read' && ['alice', 'carol'].includes(req.principal.id)) return permit();
        if (req.permission === 'task:update' && req.principal.id === 'carol') return permit();
        return {};
      },
    }),
  ],
  config: {
    fs: { uploads: { mode: 'enforce', domain: 'fs', resolver: 'TaskAttachmentPathResolver', inherit: { 'fs:read': 'read', 'fs:write': 'update', 'fs:delete': 'update' } } },
    domains: { fs: { combine: { default: { algorithm: 'deny-overrides', models: ['m1', 'fs-inherit'] } } } },
  },
  lane: {
    fs: {
      providers: [{ name: 'uploads', files: { 'tasks/42/a.pdf': 'A', 'tasks/43/b.pdf': 'B' } }],
      resolvers: [{ name: 'TaskAttachmentPathResolver', fs: 'uploads', prefix: 'tasks/', type: 'task' }],
    },
  },
};

export const B29Fs = extension('B29', [
  {
    name: 'fs',
    facets: ['engine', 'host', 'fs'],
    lanes: ['L7'],
    note: "The DI part of B29 is F2's packages/di/test/child-chain.test.ts.",
    world,
    cases: [
      {
        name: 'fs-inherit in the fs domain permits fs:read through the parent task:read',
        steps: [as('alice', fsCall('uploads', 'read', ['tasks/42/a.pdf'], 'resolves'), fsCall('uploads', 'read', ['tasks/43/b.pdf'], DENIED)), as('bob', fsCall('uploads', 'read', ['tasks/42/a.pdf'], DENIED))],
      },
      { name: 'fs-inherit maps fs:write to the parent task:update', steps: [as('alice', fsCall('uploads', 'write', ['tasks/42/new.txt', 'x'], DENIED)), as('carol', fsCall('uploads', 'write', ['tasks/42/new.txt', 'x'], 'resolves'))] },
      { name: 'the root domain never sees the fs domain models', steps: [{ models: ['m1'] }] },
    ],
  },
]);
