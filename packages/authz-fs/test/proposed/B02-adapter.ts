import { fixtureDsl, laneSteps, userPrincipal } from '@spinajs/authz-testing';
import type { Case, World } from '@spinajs/authz-testing';

const { combine, extension, permit, staticModel } = fixtureDsl;
const { as, fsCall, fsRaw } = laneSteps;

const alice = userPrincipal('alice');

/** uploads holds a.txt and has a `compact` method no operation table maps; m1 permits alice everything. */
const fsWorld = (fs: Readonly<Record<string, unknown>>, permissions: World['permissions'] = []): World => ({
  permissions,
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: (req) => (req.principal.id === 'alice' ? permit() : {}) })],
  config: { fs },
  lane: { fs: { providers: [{ name: 'uploads', files: { 'a.txt': 'A' }, extraMethods: ['compact'] }] } },
});

const unregistered = (mode: string) => ({ uploads: { mode, operations: { compact: 'fs:compact' } } });

const cases: Case[] = [
  {
    name: 'enforce: an operation mapped to an unregistered permission fails the boot of the domain that checks the filesystem',
    world: fsWorld(unregistered('enforce')),
    boot: { throws: 'AuthzConfigError', message: ['$domain', 'fs:compact', 'authz.fs.uploads.operations.compact'] },
    steps: [],
  },
  {
    name: 'audit: the same mapping fails the boot too',
    world: fsWorld(unregistered('audit')),
    boot: { throws: 'AuthzConfigError', message: ['fs:compact'] },
    steps: [],
  },
  {
    name: "control: mode 'off' maps nothing, so the domain boots",
    world: fsWorld(unregistered('off')),
    steps: [fsRaw('uploads', true)],
  },
  {
    name: 'control: a filesystem checked in another domain does not fail this one',
    world: fsWorld({ uploads: { mode: 'enforce', domain: 'elsewhere', operations: { compact: 'fs:compact' } } }),
    steps: [fsRaw('uploads', false)],
  },
  {
    name: 'control: with the permission registered the domain boots and the method is checked',
    world: fsWorld(unregistered('enforce'), [{ name: 'fs:compact', types: ['fs', 'dir', 'file'] }]),
    steps: [as('alice', fsCall('uploads', 'compact', ['a.txt'], 'resolves')), { calls: { model: 'm1', atLeast: 1 } }, fsCall('uploads', 'compact', ['a.txt'], { throws: 'AccessDenied', reason: 'unattended' })],
  },
];

/** B02.adapter (design §6.5 rule 7): written as kit data so an RFC can move it into the kit's B02 fixture. */
export const B02Adapter = extension('B02', [
  {
    name: 'adapter',
    facets: ['boot', 'fs'],
    lanes: ['L7'],
    note: "authz.fs.<name>.operations extends the fs adapter's operation table; FsAuthzContributor hands the domain that checks the filesystem every permission of it.",
    cases,
  },
]);
