import { SYSTEM } from '@spinajs/authz';

import type { VoteFn } from '../fakes/index.js';
import { userPrincipal } from '../principals.js';
import { combine, fixture, permit, staticModel } from './dsl.js';
import { as, fsCall, fsRaw } from './lane.js';
import type { FsArg } from './lane.js';
import type { Case, Step, World } from './types.js';

const alice = userPrincipal('alice');
const FILES = { 'docs/a.txt': 'A', 'docs/b.txt': 'B' };

export interface FsGrant {
  readonly permission: string;
  /** The resource id ends with this path (ids are `<fs>:<path>`, study §9.2). */
  readonly path: string;
}

/** m1 permits alice exactly these permissions on these paths. */
export const fsGrants =
  (list: readonly FsGrant[]): VoteFn =>
  (req) =>
    req.principal.id === 'alice' && list.some((g) => g.permission === req.permission && (req.resource.id ?? '').endsWith(g.path)) ? permit() : {};

/**
 * uploads: enforce, archive: audit, scratch: off, plain: no entry. The fs:* permissions come from
 * authz-fs (design §13), not from the world.
 */
export const fsWorld = (votes: VoteFn): World => ({
  permissions: [],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes })],
  // audit.denials: the 'audit' mode cases look for the recorded denial.
  config: { audit: { denials: true, runAs: true, unscoped: true }, fs: { uploads: { mode: 'enforce' }, archive: { mode: 'audit' }, scratch: { mode: 'off' } } },
  lane: {
    fs: {
      providers: [
        { name: 'uploads', files: FILES },
        { name: 'archive', files: FILES },
        { name: 'scratch', files: FILES },
        { name: 'plain', files: FILES },
      ],
    },
  },
});

const read = (path: string): FsGrant => ({ permission: 'fs:read', path });
const stat = (path: string): FsGrant => ({ permission: 'fs:stat', path });
const write = (path: string): FsGrant => ({ permission: 'fs:write', path });
const remove = (path: string): FsGrant => ({ permission: 'fs:delete', path });

interface Operation {
  readonly method: string;
  readonly args: readonly FsArg[];
  readonly needs: readonly FsGrant[];
  readonly before?: readonly Step[];
}

const A = 'docs/a.txt';
const UPLOADS = { fs: 'uploads' };
const ARCHIVE = { fs: 'archive' };
const SCRATCH = { fs: 'scratch' };
const EXCLUSIVE = { exclusive: true };

// Study §9.3, the action table of @spinajs/fs.
const OPERATIONS: readonly Operation[] = [
  ...['read', 'readStream', 'download', 'hash', 'metadata'].map((method) => ({ method, args: [A], needs: [read(A)] })),
  ...['exists', 'stat'].map((method) => ({ method, args: [A], needs: [stat(A)] })),
  ...['isDir', 'dirExists'].map((method) => ({ method, args: ['docs'], needs: [stat('docs')] })),
  { method: 'list', args: ['docs'], needs: [{ permission: 'fs:list', path: 'docs' }] },
  { method: 'write', args: ['new.txt', 'x'], needs: [write('new.txt')] },
  { method: 'writeStream', args: ['new.txt'], needs: [write('new.txt')] },
  { method: 'append', args: [A, 'x'], needs: [write(A)] },
  { method: 'mkdir', args: ['newdir'], needs: [write('newdir')] },
  { method: 'upload', args: [{ localFile: 'L' }, 'up.txt'], needs: [write('up.txt')] },
  { method: 'rm', args: [A], needs: [remove(A)] },
  { method: 'copy', args: [A, 'copy.txt'], needs: [read(A), write('copy.txt')] },
  { method: 'move', args: [A, 'moved.txt'], needs: [read(A), remove(A), write('moved.txt')] },
  { method: 'rename', args: [A, 'renamed.txt'], needs: [read(A), remove(A), write('renamed.txt')] },
  { method: 'zip', args: [[A], UPLOADS, 'out.zip'], needs: [read(A), write('out.zip')] },
  {
    method: 'unzip',
    args: ['arch.zip', 'unz', UPLOADS],
    needs: [read('arch.zip'), write('unz')],
    before: [{ runAs: { as: SYSTEM, reason: 'behaviour fixture' }, steps: [fsCall('uploads', 'zip', [['docs/b.txt'], UPLOADS, 'arch.zip'], 'resolves')] }],
  },
];

const label = (g: FsGrant): string => `${g.permission} on ${g.path}`;

function mapping(op: Operation): Case[] {
  const call = (expect: 'resolves' | { readonly throws: string }) => [...(op.before ?? []), as('alice', fsCall('uploads', op.method, op.args, expect))];
  return [
    { name: `enforce: ${op.method} needs ${op.needs.map(label).join(' and ')}`, world: fsWorld(fsGrants(op.needs)), steps: call('resolves') },
    ...op.needs.map((dropped) => ({
      name: `enforce: ${op.method} without ${label(dropped)} is AccessDenied`,
      world: fsWorld(fsGrants(op.needs.filter((g) => g !== dropped))),
      steps: call({ throws: 'AccessDenied' }),
    })),
  ];
}

const NONE: VoteFn = () => ({});
const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;
const DENIED = { throws: 'AccessDenied' } as const;
const BAD_PATH = { throws: 'InvalidArgument' } as const;

const modes: Case[] = [
  { name: 'a filesystem without an authz.fs entry is never checked', world: fsWorld(NONE), steps: [fsCall('plain', 'read', [A], 'resolves'), NOT_CALLED] },
  { name: "mode 'off' is never checked", world: fsWorld(NONE), steps: [fsCall('scratch', 'read', [A], 'resolves'), NOT_CALLED] },
  { name: "mode 'enforce' checks the call and throws AccessDenied", world: fsWorld(NONE), steps: [fsCall('uploads', 'read', [A], { throws: 'AccessDenied', reason: 'unattended' })] },
  {
    name: "mode 'audit' decides, records the denial and allows",
    world: fsWorld(NONE),
    steps: [as('alice', fsCall('archive', 'read', [A], 'resolves')), { calls: { model: 'm1', atLeast: 1 } }, { audit: { kind: 'deny', permission: 'fs:read', principal: 'alice' } }],
  },
  { name: 'getFs returns the provider itself in every mode', world: fsWorld(NONE), steps: ['uploads', 'archive', 'scratch', 'plain'].map((name) => fsRaw(name, true)) },
  {
    name: 'resolvePath, tmppath and tmpname are not checks',
    world: fsWorld(NONE),
    steps: [fsCall('uploads', 'resolvePath', [A], 'resolves'), fsCall('uploads', 'tmppath', [], 'resolves'), fsCall('uploads', 'tmpname', [], 'resolves'), NOT_CALLED],
  },
];

const paths: Case[] = [
  {
    name: 'a path above the root is InvalidArgument before any check, in every mode',
    world: fsWorld(NONE),
    steps: [as('alice', fsCall('uploads', 'read', ['../a.txt'], BAD_PATH), fsCall('archive', 'read', ['docs/../../a.txt'], BAD_PATH), fsCall('plain', 'write', ['../escape.txt', 'x'], BAD_PATH)), NOT_CALLED],
  },
  {
    name: 'the normalised path is the path checked',
    world: fsWorld(fsGrants([read(A)])),
    steps: [as('alice', fsCall('uploads', 'read', ['docs/./x/../a.txt'], 'resolves'), fsCall('uploads', 'read', ['/docs/a.txt'], 'resolves'), fsCall('uploads', 'read', ['docs/./x/../b.txt'], DENIED))],
  },
];

// Each target is checked with the mode of its own filesystem.
const crossFs: Case[] = [
  { name: "copy to an 'off' filesystem checks only the source", world: fsWorld(fsGrants([read(A)])), steps: [as('alice', fsCall('uploads', 'copy', [A, 'copied.txt', SCRATCH], 'resolves'))] },
  { name: "copy to an 'off' filesystem without fs:read on the source is AccessDenied", world: fsWorld(NONE), steps: [as('alice', fsCall('uploads', 'copy', [A, 'copied.txt', SCRATCH], DENIED))] },
  { name: "copy from an 'off' filesystem checks only the destination", world: fsWorld(fsGrants([write('in.txt')])), steps: [as('alice', fsCall('scratch', 'copy', [A, 'in.txt', UPLOADS], 'resolves'))] },
  { name: "copy from an 'off' filesystem without fs:write on the destination is AccessDenied", world: fsWorld(NONE), steps: [as('alice', fsCall('scratch', 'copy', [A, 'in.txt', UPLOADS], DENIED))] },
  {
    name: "copy to an 'audit' filesystem records the destination denial and copies",
    world: fsWorld(fsGrants([read(A)])),
    steps: [as('alice', fsCall('uploads', 'copy', [A, 'audited.txt', ARCHIVE], 'resolves')), { audit: { kind: 'deny', permission: 'fs:write', principal: 'alice' } }],
  },
];

// The options reach the provider through the middlewares; the check runs first, so a denial never reveals whether the file exists.
const exclusive: Case[] = [
  { name: 'enforce: an exclusive upload onto a free path needs fs:write on it', world: fsWorld(fsGrants([write('fresh.txt')])), steps: [as('alice', fsCall('uploads', 'upload', [{ localFile: 'L' }, 'fresh.txt', EXCLUSIVE], 'resolves'))] },
  {
    name: 'enforce: an exclusive upload onto an existing file passes the check, then throws ResourceDuplicated',
    world: fsWorld(fsGrants([write(A)])),
    steps: [as('alice', fsCall('uploads', 'upload', [{ localFile: 'L' }, A, EXCLUSIVE], { throws: 'ResourceDuplicated' }))],
  },
  {
    name: 'enforce: an exclusive upload without fs:write is AccessDenied, whether or not the file exists',
    world: fsWorld(NONE),
    steps: [as('alice', fsCall('uploads', 'upload', [{ localFile: 'L' }, A, EXCLUSIVE], DENIED), fsCall('uploads', 'upload', [{ localFile: 'L' }, 'fresh.txt', EXCLUSIVE], DENIED))],
  },
];

export const B28 = fixture('B28', [
  {
    name: 'fs',
    facets: ['engine', 'host', 'audit', 'fs'],
    lanes: ['L7'],
    note: "Release gate item 4 runs this part on local, temp and S3 providers (authz-fs: fsHarness({ kind }) per kind; the s3 suites need localstack and fail instead of skipping under AUTHZ_FS_S3=required). signedUrl (fs:share and its TTL rule) needs a provider with signed URLs; L7 proposes those cases by RFC.",
    cases: [...modes, ...paths, ...crossFs, ...exclusive, ...OPERATIONS.flatMap(mapping)],
  },
]);
