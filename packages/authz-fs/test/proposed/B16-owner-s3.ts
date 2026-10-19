import { SYSTEM } from '@spinajs/authz';
import { fixtureDsl, laneSteps, userPrincipal } from '@spinajs/authz-testing';
import type { Case, World } from '@spinajs/authz-testing';

const { assignment, combine, extension, role } = fixtureDsl;
const { as, fsCall } = laneSteps;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const DENIED = { throws: 'AccessDenied' } as const;
const UPLOADS = [{ type: 'fs', id: 'uploads' }];

/**
 * B16.fs-owner's world with the owners kept on the S3 objects (S3ObjectMetadataStore), plus a shared folder every
 * user reads, so one user can copy another's file. Runs on the s3 kind only: the store needs fsS3.
 */
const s3OwnerWorld: World = {
  permissions: [],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'rbac'),
  config: { fs: { uploads: { mode: 'enforce', metadata: 'S3ObjectMetadataStore', stampOwner: true } } },
  rbac: {
    roles: [
      role('user', [
        { permission: 'fs:read', relation: 'owner', on: UPLOADS },
        { permission: 'fs:delete', relation: 'owner', on: UPLOADS },
        { permission: 'fs:write', on: UPLOADS },
        { permission: 'fs:read', on: [{ type: 'file', id: 'uploads:shared/*' }] },
      ]),
    ],
    assignments: [assignment('u1', alice, 'user'), assignment('u2', bob, 'user')],
  },
  lane: { fs: { providers: [{ name: 'uploads' }] } },
};

const read = (path: string, expect: 'resolves' | typeof DENIED) => fsCall('uploads', 'read', [path], expect);
const write = (path: string) => fsCall('uploads', 'write', [path, 'x'], 'resolves');
const rm = (path: string, expect: 'resolves' | typeof DENIED) => fsCall('uploads', 'rm', [path], expect);

const cases: Case[] = [
  {
    name: "a copy of another user's file to a new key is the copier's, though S3 copies the object metadata along",
    steps: [as('alice', write('shared/template.txt')), as('bob', fsCall('uploads', 'copy', ['shared/template.txt', 'bob/notes.txt'], 'resolves'), read('bob/notes.txt', 'resolves'), write('bob/notes.txt'), read('bob/notes.txt', 'resolves')), as('alice', read('bob/notes.txt', DENIED), rm('bob/notes.txt', DENIED))],
  },
  {
    name: 'a SYSTEM copy to a new key has no owner',
    steps: [as('alice', write('shared/template.txt')), as(SYSTEM, fsCall('uploads', 'copy', ['shared/template.txt', 'system.txt'], 'resolves')), as('alice', read('system.txt', DENIED)), as('bob', read('system.txt', DENIED))],
  },
  {
    name: 'a write stamps the writer, and an overwrite by another user keeps the first owner',
    steps: [as('alice', write('a.txt'), read('a.txt', 'resolves')), as('bob', read('a.txt', DENIED), write('a.txt'), read('a.txt', DENIED)), as('alice', read('a.txt', 'resolves'))],
  },
  {
    name: 'an append by another user keeps the first owner, though fsS3 re-uploads the object',
    steps: [as('alice', write('a.txt')), as('bob', fsCall('uploads', 'append', ['a.txt', 'more'], 'resolves'), read('a.txt', DENIED)), as('alice', read('a.txt', 'resolves'))],
  },
  {
    name: 'a move carries the owner to the new key',
    steps: [as('alice', write('a.txt'), fsCall('uploads', 'move', ['a.txt', 'docs/b.txt'], 'resolves'), read('docs/b.txt', 'resolves')), as('bob', read('docs/b.txt', DENIED))],
  },
];

/** B16.fs-owner-s3: the owner grant with S3ObjectMetadataStore under the guard (final L7 review, Important 1). */
export const B16OwnerS3 = extension('B16', [
  {
    name: 'fs-owner-s3',
    facets: ['engine', 'host', 'rbac', 'fs'],
    lanes: ['L7'],
    note: 'B16.fs-owner on S3 with the owners kept in the object metadata. A same-bucket CopyObject copies the user metadata, so a created key must end with the writer as owner (D10 rev.), not the source\'s.',
    world: s3OwnerWorld,
    cases,
  },
]);
