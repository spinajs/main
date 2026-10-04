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
 * Design §8.2's owner grant: every user may write in uploads, and reads and deletes only what they own.
 * The harness registers the MemoryFileMetadataStore the config names (one per case).
 */
const ownerWorld: World = {
  permissions: [],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'rbac'),
  config: { fs: { uploads: { mode: 'enforce', metadata: 'MemoryFileMetadataStore', stampOwner: true } } },
  rbac: {
    roles: [
      role('user', [
        { permission: 'fs:read', relation: 'owner', on: UPLOADS },
        { permission: 'fs:delete', relation: 'owner', on: UPLOADS },
        { permission: 'fs:write', on: UPLOADS },
      ]),
    ],
    assignments: [assignment('u1', alice, 'user'), assignment('u2', bob, 'user')],
  },
  lane: { fs: { providers: [{ name: 'uploads', files: { 'old.txt': 'O' } }] } },
};

const read = (path: string, expect: 'resolves' | typeof DENIED) => fsCall('uploads', 'read', [path], expect);
const write = (path: string) => fsCall('uploads', 'write', [path, 'x'], 'resolves');

const cases: Case[] = [
  {
    name: 'a file alice writes is stamped with her: she reads it, bob does not',
    steps: [as('alice', write('mine.txt'), read('mine.txt', 'resolves')), as('bob', read('mine.txt', DENIED))],
  },
  {
    name: 'a file written through a stream is stamped once the stream closes',
    steps: [as('alice', fsCall('uploads', 'writeStream', ['s.txt'], 'resolves'), read('s.txt', 'resolves')), as('bob', read('s.txt', DENIED))],
  },
  {
    name: 'a file nobody stamped has no owner: present at setup, or written by SYSTEM',
    steps: [as('alice', read('old.txt', DENIED)), as(SYSTEM, write('sys.txt')), as('alice', read('sys.txt', DENIED))],
  },
  {
    name: 'rm drops the owner: a file SYSTEM writes later at that path is not the old owner’s',
    steps: [as('alice', write('a.txt'), fsCall('uploads', 'rm', ['a.txt'], 'resolves')), as(SYSTEM, write('a.txt')), as('alice', read('a.txt', DENIED))],
  },
  {
    name: 'only the owner deletes; a denied rm keeps the file and its owner',
    steps: [as('alice', write('a.txt')), as('bob', fsCall('uploads', 'rm', ['a.txt'], DENIED)), as('alice', read('a.txt', 'resolves'))],
  },
  {
    name: 'move: the owner follows the file, and the old path is no longer theirs',
    steps: [as('alice', write('a.txt'), fsCall('uploads', 'move', ['a.txt', 'docs/b.txt'], 'resolves'), read('docs/b.txt', 'resolves')), as('bob', read('docs/b.txt', DENIED)), as(SYSTEM, write('a.txt')), as('alice', read('a.txt', DENIED))],
  },
  {
    name: 'append keeps the first owner',
    steps: [as('alice', write('a.txt')), as('bob', fsCall('uploads', 'append', ['a.txt', 'more'], 'resolves'), read('a.txt', DENIED)), as('alice', read('a.txt', 'resolves'))],
  },
  {
    name: 'an overwrite keeps the first owner: fs:write on a file gives no owner rights over it',
    steps: [as('alice', write('a.txt')), as('bob', write('a.txt'), read('a.txt', DENIED), fsCall('uploads', 'rm', ['a.txt'], DENIED)), as('alice', read('a.txt', 'resolves'))],
  },
  {
    name: "unzipping into another user's directory does not take it over, so its files cannot be deleted",
    steps: [
      as('alice', fsCall('uploads', 'mkdir', ['alice-dir'], 'resolves'), write('alice-dir/a.txt')),
      as('bob', write('b.txt'), fsCall('uploads', 'zip', [['b.txt'], { fs: 'uploads' }, 'bob.zip'], 'resolves'), fsCall('uploads', 'unzip', ['bob.zip', 'alice-dir', { fs: 'uploads' }], 'resolves'), fsCall('uploads', 'rm', ['alice-dir'], DENIED)),
      as('alice', read('alice-dir/a.txt', 'resolves')),
    ],
  },
];

/** B16.fs-owner: the owner grant of design §8.2 through the real RBAC model, the fs guard and a metadata store (L7 task 5). */
export const B16Owner = extension('B16', [
  {
    name: 'fs-owner',
    facets: ['engine', 'host', 'rbac', 'fs'],
    lanes: ['L7'],
    note: 'Design §8.2 and study §9.2 "Per file owner": fs:read with relation owner on fs:uploads. The guard stamps the principal as owner after a write (D10) and the owner relation of FsResourceAdapter reads it from the FileMetadataStore; a conditional permit never passes (D13).',
    world: ownerWorld,
    cases,
  },
]);
