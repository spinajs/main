import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, ref, role } from './dsl.js';
import { as, fsCall } from './lane.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice', { attributes: { pool: 'p1' } });
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const erin = userPrincipal('erin');
const frank = userPrincipal('frank');

const DOC_IDS = ['pub-1', 'pub-2', 'priv-1', 'alice-1', 'bob-1', 'p1-x', '-x', 'undefined-x'];

const HOME = ref('dir', 'home');
const HOME_ALICE = ref('dir', 'home/alice');
const HOME_ALICE_DOCS = ref('dir', 'home/alice/docs');
const HOME_BOB = ref('dir', 'home/bob');

const world: World = {
  permissions: [
    { name: 'doc:read', types: ['doc', 'note'] },
    { name: 'dir:list', types: ['dir'] },
  ],
  principals: { alice, bob, carol, dave, erin, frank },
  adapters: [{ types: ['doc', 'note'], rows: { doc: DOC_IDS.map((id) => ({ id })), note: [{ id: 'n1' }] } }],
  scopes: [
    {
      nodes: [
        { ref: HOME_ALICE, parent: HOME },
        { ref: HOME_ALICE_DOCS, parent: HOME_ALICE },
        { ref: HOME_BOB, parent: HOME },
      ],
    },
  ],
  combine: combine('deny-overrides', 'rbac'),
  rbac: {
    roles: [role('one', [{ permission: 'doc:read', on: [{ type: 'doc', id: 'pub-1' }] }]), role('typed', [{ permission: 'doc:read', on: [{ type: 'doc' }] }]), role('public', [{ permission: 'doc:read', on: [{ type: 'doc', id: 'pub-*' }] }]), role('own', [{ permission: 'doc:read', on: [{ type: 'doc', id: '{principal.id}-*' }] }]), role('pool', [{ permission: 'doc:read', on: [{ type: 'doc', id: '{principal.attributes.pool}-*' }] }]), role('home', [{ permission: 'dir:list', on: [{ type: 'dir', id: 'home/{principal.id}' }] }])],
    assignments: [assignment('a1', alice, 'own'), assignment('a2', alice, 'pool'), assignment('a3', alice, 'home'), assignment('b1', bob, 'own'), assignment('c1', carol, 'pool'), assignment('d1', dave, 'one'), assignment('f1', frank, 'typed'), assignment('e1', erin, 'public')],
  },
};

const doc = (as: string, id: string, allowed: boolean) => ({ check: { as, permission: 'doc:read', resource: ref('doc', id), subject: 'row' as const }, expect: { allowed } });
const docs = (as: string, selects: string[]) => ({ filter: { as, permission: 'doc:read', type: 'doc' }, expect: { selects } });
const note = (as: string, allowed: boolean) => ({ check: { as, permission: 'doc:read', resource: ref('note', 'n1'), subject: 'row' as const }, expect: { allowed } });
const dir = (as: string, r: typeof HOME, allowed: boolean) => ({ check: { as, permission: 'dir:list', resource: r, subject: { id: r.id } }, expect: { allowed } });

const cases: Case[] = [
  { name: 'a pattern with an id limits the grant to that resource', steps: [doc('dave', 'pub-1', true), doc('dave', 'pub-2', false), note('dave', false)] },
  { name: 'a pattern with a type only limits the grant to that type', steps: [doc('frank', 'priv-1', true), docs('frank', DOC_IDS), note('frank', false)] },
  { name: 'a glob limits the grant to the ids it matches', steps: [docs('erin', ['pub-1', 'pub-2']), doc('erin', 'pub-2', true), doc('erin', 'priv-1', false), note('erin', false)] },
  { name: '{principal.id} substitutes the id of the principal', steps: [docs('bob', ['bob-1']), doc('bob', 'alice-1', false), doc('bob', 'bob-1', true)] },
  { name: '{principal.attributes.*} substitutes an attribute of the principal', steps: [docs('alice', ['alice-1', 'p1-x']), doc('alice', 'p1-x', true)] },
  { name: 'a missing attribute matches nothing', steps: [docs('carol', []), doc('carol', '-x', false), doc('carol', 'undefined-x', false), doc('carol', 'p1-x', false)] },
  { name: 'an id pattern on a tree type covers that node and its descendants (prefix)', steps: [dir('alice', HOME_ALICE, true), dir('alice', HOME_ALICE_DOCS, true), dir('alice', HOME_BOB, false), dir('alice', HOME, false)] },
];

// fs: the grants of design §8.2 on a guarded filesystem. Files are `file` refs and directories `dir`
// refs with ids `<fs>:<path>` (§13), so the pattern ids carry the `uploads:` prefix.
const FS_FILES = {
  'users/alice/a.txt': 'A',
  'users/alice/docs/b.txt': 'B',
  'users/alice2/x.txt': 'X',
  'users/bob/b.txt': 'B',
  'shared/a.txt': 'S',
  'shared/sub/c.txt': 'C',
  'public/top.txt': 'T',
  'public/x/y.txt': 'Y',
  'docs/a.txt': 'D',
};

const fsWorld: World = {
  permissions: [],
  principals: { alice, bob },
  combine: combine('deny-overrides', 'rbac'),
  config: { fs: { uploads: { mode: 'enforce' } } },
  rbac: {
    roles: [
      role('user', [
        { permission: 'fs:*', on: [{ type: 'dir', id: 'uploads:users/{principal.id}' }] },
        { permission: 'fs:read', on: [{ type: 'file', id: 'uploads:shared/*' }] },
        { permission: 'fs:read', on: [{ type: 'file', id: 'uploads:public/**' }] },
      ]),
    ],
    assignments: [assignment('u1', alice, 'user'), assignment('u2', bob, 'user')],
  },
  lane: { fs: { providers: [{ name: 'uploads', files: FS_FILES }] } },
};

const DENIED = { throws: 'AccessDenied' } as const;
const read = (path: string, expect: 'resolves' | typeof DENIED) => fsCall('uploads', 'read', [path], expect);

const fsCases: Case[] = [
  {
    name: '{principal.id} in a dir pattern grants the directory of the principal and everything under it',
    steps: [as('alice', read('users/alice/a.txt', 'resolves'), read('users/alice/docs/b.txt', 'resolves'), fsCall('uploads', 'write', ['users/alice/new.txt', 'x'], 'resolves'), fsCall('uploads', 'list', ['users/alice'], 'resolves')), as('bob', read('users/bob/b.txt', 'resolves'))],
  },
  {
    name: 'a path outside the granted directory is denied',
    steps: [as('alice', read('users/bob/b.txt', DENIED), read('docs/a.txt', DENIED), fsCall('uploads', 'list', ['users'], DENIED)), as('bob', read('users/alice/a.txt', DENIED))],
  },
  { name: 'a dir pattern without a glob means under that node, not a string prefix', steps: [as('alice', read('users/alice2/x.txt', DENIED))] },
  {
    name: "a glob pattern: '*' matches within one path segment",
    steps: [as('alice', read('shared/a.txt', 'resolves'), read('shared/sub/c.txt', DENIED), fsCall('uploads', 'write', ['shared/new.txt', 'x'], DENIED))],
  },
  { name: "a glob pattern: '**' crosses '/'", steps: [as('alice', read('public/top.txt', 'resolves'), read('public/x/y.txt', 'resolves'))] },
];

export const B16 = fixture('B16', [
  {
    name: 'rbac',
    facets: ['engine', 'rbac'],
    lanes: ['L1'],
    note: 'Design §6.1.2: a pattern becomes under (prefix) or cmp glob on the id after {principal.*} substitution. Patterns name a type, so a note (another type of doc:read) is outside every grant here.',
    world,
    cases,
  },
  {
    name: 'fs',
    facets: ['engine', 'host', 'rbac', 'fs'],
    lanes: ['L7'],
    note: 'Grant patterns through the fs guard (design §6.1.2 lines 1119-1121, §8.2): a pattern id without glob characters becomes under that node, so a dir pattern covers the files below it; a glob becomes cmp glob on the id, segment-aware (§5.3). The harness wires the lane RBAC model; the fs:* permissions come from authz-fs, not from the world (as in B28). The owner grant of §8.2 (fs:read with relation owner) needs FileMetadataStore owners and is left to L7.',
    world: fsWorld,
    cases: fsCases,
  },
]);
