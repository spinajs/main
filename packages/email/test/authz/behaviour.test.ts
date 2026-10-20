import 'mocha';

import { BEHAVIOUR_FIXTURES, fixtureDsl, laneSteps, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { FixturePart, StepContext, VoteFn, World } from '@spinajs/authz-testing';

import { emailHarness } from './email-harness.js';
import type { EmailLaneHandle } from './email-harness.js';

const { combine, extension, permit, staticModel } = fixtureDsl;
const { as, laneCall, laneHandle } = laneSteps;

// The world of B28's fsWorld (uploads: enforce, archive: audit, scratch: off, plain: no entry), which the kit does
// not export. m1 permits alice fs:read on docs/a.txt only.
const READ_A: VoteFn = (req) => (req.principal.id === 'alice' && req.permission === 'fs:read' && (req.resource.id ?? '').endsWith('docs/a.txt') ? permit() : {});
const NONE: VoteFn = () => ({});
const FILES = { 'docs/a.txt': 'A', 'docs/b.txt': 'B' };

const world = (votes: VoteFn): World => ({
  permissions: [],
  principals: { alice: userPrincipal('alice') },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes })],
  config: { audit: { denials: true, runAs: true, unscoped: true }, fs: { uploads: { mode: 'enforce' }, archive: { mode: 'audit' }, scratch: { mode: 'off' } } },
  lane: { fs: { providers: ['uploads', 'archive', 'scratch', 'plain'].map((name) => ({ name, files: FILES })) } },
});

const email = (ctx: StepContext) => laneHandle(ctx, 'email') as EmailLaneHandle;
const mail = (fs: string, path: string) => ({ to: 'x@example.com', attachments: [{ fs, path }] });
const send = (fs: string, path: string) => (ctx: StepContext) => email(ctx).send(mail(fs, path));

const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;
const UNATTENDED_DENIED = { throws: 'AccessDenied', reason: 'unattended' } as const;

const modesPart: FixturePart = {
  name: 'email-modes',
  facets: ['engine', 'host', 'audit', 'fs', 'email'],
  lanes: ['C9'],
  note: 'Attachments follow the mode of their filesystem (design §13).',
  world: world(NONE),
  cases: [
    {
      name: "an attachment of an 'audit' filesystem is sent and the denial recorded",
      steps: [as('alice', laneCall('send archive docs/a.txt', send('archive', 'docs/a.txt'), 'resolves')), { audit: { kind: 'deny', permission: 'fs:read', principal: 'alice' } }],
    },
    { name: "an attachment of an 'off' filesystem is sent without a check, even unattended", steps: [laneCall('send scratch docs/a.txt', send('scratch', 'docs/a.txt'), 'resolves'), NOT_CALLED] },
    { name: 'an attachment of a filesystem without an authz.fs entry is sent without a check, even unattended', steps: [laneCall('send plain docs/a.txt', send('plain', 'docs/a.txt'), 'resolves'), NOT_CALLED] },
  ],
};

const deferred = (path: string) => (ctx: StepContext) => email(ctx).sendDeferred(mail('uploads', path));
const consume = (ctx: StepContext) => email(ctx).consume();

const deferredPart: FixturePart = {
  name: 'email-deferred',
  facets: ['engine', 'host', 'fs', 'email'],
  lanes: ['C9', 'L6'],
  note: 'EmailSend is @Job({ runAs: initiator }): the consumer reads attachments as the principal that queued the mail.',
  world: world(READ_A),
  cases: [
    { name: 'a mail alice queued is sent with her right to read the attachment', steps: [as('alice', laneCall('queue docs/a.txt', deferred('docs/a.txt'), 'resolves')), laneCall('consume', consume, 'resolves')] },
    { name: 'a mail alice queued with a file she may not read is refused on consume', steps: [as('alice', laneCall('queue docs/b.txt', deferred('docs/b.txt'), 'resolves')), laneCall('consume', consume, { throws: 'AccessDenied' })] },
    { name: 'a mail queued without a principal runs unattended and is refused', steps: [laneCall('queue docs/a.txt', deferred('docs/a.txt'), 'resolves'), laneCall('consume', consume, UNATTENDED_DENIED)] },
  ],
};

// One harness for the kit's part and the own ones.
runBehaviour(['B09.email', 'B09.email-modes', 'B09.email-deferred'], () => emailHarness(), {
  strict: true,
  timeoutMs: 30000,
  fixtures: [...BEHAVIOUR_FIXTURES, extension('B09', [modesPart, deferredPart])],
});
