import assert from 'node:assert/strict';

import { fixtureDsl, laneSteps, userPrincipal } from '@spinajs/authz-testing';
import type { Case, DoStep, FsArg, RelationSpec, VoteFn, World } from '@spinajs/authz-testing';

const { cmp, combine, deny, extension, permit, relation, staticModel } = fixtureDsl;
const { as, fsCall, laneHandle } = laneSteps;

const alice = userPrincipal('alice');
const A = 'docs/a.txt';
const B = 'docs/b.txt';
const DENIED = { throws: 'AccessDenied' } as const;

/** m1 votes only for alice. uploads and archive are enforced in the test domain. */
const residualWorld = (votes: VoteFn, opts: { relations?: readonly RelationSpec[]; uploads?: Readonly<Record<string, unknown>> } = {}): World => ({
  permissions: [],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req, ctx) => (req.principal.id === 'alice' ? votes(req, ctx) : {}) })],
  ...(opts.relations ? { relations: opts.relations } : {}),
  config: { fs: { uploads: { mode: 'enforce', ...opts.uploads }, archive: { mode: 'enforce' } } },
  lane: { fs: { providers: [{ name: 'uploads', files: { [A]: 'A', [B]: 'B' } }, { name: 'archive' }] } },
});

const editor = (holds: (id: string) => boolean): RelationSpec[] => ['file', 'dir', 'fs'].map((type) => ({ type, relation: 'editor', holds: (_p, ref) => holds(ref.id ?? '') }));

const idIs = (id: string) => cmp('id', 'eq', id);

/** Entries are compared as names in `dir`: fsS3 lists whole keys (`docs/a.txt`), fsNative names (`a.txt`). */
const listed = (fs: string, dir: string, expected: readonly string[]): DoStep => ({
  note: `${fs}.list(${dir}) gives ${expected.join(', ')}`,
  do: async (ctx) => {
    const entries = (await laneHandle(ctx, 'fs').call(fs, 'list', [dir as FsArg])) as string[];
    const names = entries.map((e) => (e.startsWith(`${dir}/`) ? e.slice(dir.length + 1) : e));
    assert.deepEqual(names.sort(), [...expected].sort(), `${fs}.list(${dir})`);
  },
});

const cases: Case[] = [
  {
    name: 'a relation that does not hold is a denial, never a permit for every file',
    world: residualWorld(() => permit(relation('editor')), { relations: editor(() => false) }),
    steps: [as('alice', fsCall('uploads', 'read', [A], DENIED), fsCall('uploads', 'write', [B, 'x'], DENIED))],
  },
  {
    name: 'a relation that holds for one file permits that file only',
    world: residualWorld(() => permit(relation('editor')), { relations: editor((id) => id === `uploads:${A}`) }),
    steps: [as('alice', fsCall('uploads', 'read', [A], 'resolves'), fsCall('uploads', 'read', [B], DENIED))],
  },
  {
    name: 'a resource.id condition that does not match is a denial: read and write',
    world: residualWorld(() => permit(idIs('uploads:other.txt'))),
    steps: [as('alice', fsCall('uploads', 'read', [A], DENIED), fsCall('uploads', 'write', [B, 'x'], DENIED))],
  },
  {
    name: 'a resource.id condition that matches permits that path only',
    world: residualWorld(() => permit(idIs(`uploads:${A}`))),
    steps: [as('alice', fsCall('uploads', 'read', [A], 'resolves'), fsCall('uploads', 'write', [A, 'x'], 'resolves'), fsCall('uploads', 'read', [B], DENIED), fsCall('uploads', 'write', [B, 'x'], DENIED))],
  },
  {
    name: 'a copy destination on another filesystem is checked against its condition',
    world: residualWorld((req) => (req.permission === 'fs:write' ? permit(idIs('archive:kept.txt')) : permit())),
    steps: [as('alice', fsCall('uploads', 'copy', [A, 'kept.txt', { fs: 'archive' }], 'resolves'), fsCall('uploads', 'copy', [A, 'other.txt', { fs: 'archive' }], DENIED))],
  },
  {
    name: "list: 'each' keeps only the entries whose fs:stat condition holds",
    world: residualWorld((req) => (req.permission === 'fs:stat' ? permit(idIs(`uploads:${A}`)) : permit()), { uploads: { list: 'each' } }),
    steps: [as('alice', listed('uploads', 'docs', ['a.txt']))],
  },
  {
    name: 'a deny on a resource.id condition denies the matching file and spares the others',
    world: residualWorld(() => ({ ...permit(), ...deny({ code: 'blocked' }, idIs(`uploads:${B}`)) })),
    steps: [as('alice', fsCall('uploads', 'read', [A], 'resolves'), fsCall('uploads', 'read', [B], DENIED))],
  },
];

/** B28.residual: the guard decides with the path's row as the subject and never lets a conditional permit through. */
export const B28Residual = extension('B28', [
  {
    name: 'residual',
    facets: ['engine', 'host', 'fs'],
    lanes: ['L7'],
    note: "Relation grants and resource.* conditions on fs paths (design §13). 'editor' stands for any relation: FsResourceAdapter serves 'owner' itself (B16.fs-owner).",
    cases,
  },
]);
