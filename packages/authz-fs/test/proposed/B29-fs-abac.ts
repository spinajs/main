import { fixtureDsl, laneSteps, userPrincipal } from '@spinajs/authz-testing';
import type { World } from '@spinajs/authz-testing';

const { combine, extension, permit, staticModel } = fixtureDsl;
const { as, fsCall } = laneSteps;

const DENIED = { throws: 'AccessDenied' } as const;

/**
 * uploads is checked in the domain 'fs' with the policies of design §13: `public` permits fs:read and fs:stat
 * under public/, `secret` denies fs:read under secret/. m1 (test domain) permits every fs:read and fs:stat of
 * bob. The fs domain combines m1 and fs-abac with deny-overrides.
 */
const world: World = {
  permissions: [],
  principals: { alice: userPrincipal('alice'), bob: userPrincipal('bob') },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.principal.id === 'bob' && (req.permission === 'fs:read' || req.permission === 'fs:stat') ? permit() : {}) })],
  config: {
    fs: {
      uploads: {
        mode: 'enforce',
        domain: 'fs',
        policies: [
          { id: 'public', effect: 'permit', permissions: ['fs:read', 'fs:stat'], when: { attr: 'resource.id', glob: 'uploads:public/**' } },
          { id: 'secret', effect: 'deny', permissions: ['fs:read'], when: { attr: 'resource.id', glob: 'uploads:secret/**' }, reason: 'secret' },
        ],
      },
    },
    domains: { fs: { combine: { default: { algorithm: 'deny-overrides', models: ['m1', 'fs-abac'] } } } },
  },
  lane: { fs: { providers: [{ name: 'uploads', files: { 'public/a.png': 'P', 'private/b.txt': 'B', 'secret/s.txt': 'S' } }] } },
};

export const B29FsAbac = extension('B29', [
  {
    name: 'fs-abac',
    facets: ['engine', 'host', 'fs'],
    lanes: ['L7'],
    note: 'Proposed by L7: authz.fs.<name>.policies become the fs-abac model of the filesystem domain (design §13).',
    world,
    cases: [
      {
        name: 'the public policy permits fs:read and fs:stat under public/ only',
        steps: [as('alice', fsCall('uploads', 'read', ['public/a.png'], 'resolves'), fsCall('uploads', 'exists', ['public/a.png'], 'resolves'), fsCall('uploads', 'read', ['private/b.txt'], DENIED), fsCall('uploads', 'write', ['public/new.png', 'x'], DENIED))],
      },
      {
        name: 'a deny policy beats a permit of another model under deny-overrides',
        steps: [as('bob', fsCall('uploads', 'read', ['private/b.txt'], 'resolves'), fsCall('uploads', 'read', ['secret/s.txt'], DENIED), fsCall('uploads', 'exists', ['secret/s.txt'], 'resolves'))],
      },
      { name: 'the test domain never sees fs-abac', steps: [{ models: ['m1'] }] },
    ],
  },
]);
