import assert from 'node:assert/strict';

import { fixtureDsl, laneSteps, userPrincipal } from '@spinajs/authz-testing';
import type { Case, DoStep, World } from '@spinajs/authz-testing';

import type { SignedFsProviderSpec } from '../support/fs-harness.js';

const { combine, extension, permit, staticModel } = fixtureDsl;
const { as, fsCall, laneHandle } = laneSteps;

const alice = userPrincipal('alice');
const A = 'docs/a.txt';
const DENIED = { throws: 'AccessDenied' } as const;

/** m1 permits alice `permissions` on every file, with `validUntil` this many seconds ahead when set. */
const signedWorld = (permissions: readonly string[], uploads: Readonly<Record<string, unknown>> = {}, validForSeconds?: number): World => ({
  permissions: [],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [
    staticModel('m1', {
      votes: (req) => {
        if (req.principal.id !== 'alice' || !permissions.includes(req.permission)) return {};
        return validForSeconds === undefined ? permit() : permit(undefined, { validUntil: new Date(Date.now() + validForSeconds * 1000) });
      },
    }),
  ],
  config: { fs: { uploads: { mode: 'enforce', ...uploads } } },
  lane: { fs: { providers: [{ name: 'uploads', files: { [A]: 'A' }, signedUrl: true } as SignedFsProviderSpec] } },
});

/**
 * Seconds the URL is valid for: `X-Amz-Expires` of an S3 presigned URL, else `expires` (epoch ms) of the harness's
 * fake signer counted from the domain clock.
 */
function lifetimeSeconds(url: string, now: Date): number {
  const query = new URL(url).searchParams;
  const amz = query.get('X-Amz-Expires');
  if (amz !== null) return Number(amz);
  return (Number(query.get('expires')) - now.getTime()) / 1000;
}

/** `signedUrl(A)` without an asked until; the URL lives between `min` and `max` seconds. */
const lives = (method: 'signedUrl' | 'getSignedUrl', min: number, max: number): DoStep => ({
  note: `uploads.${method}(${A}) lives ${min}-${max} s`,
  do: async (ctx) => {
    const url = await laneHandle(ctx, 'fs').call('uploads', method, [A]);
    assert.equal(typeof url, 'string', `${method} result`);
    const seconds = lifetimeSeconds(url as string, ctx.session.clock!.now());
    assert.ok(seconds >= min && seconds <= max, `${method}(${A}) lives ${seconds} s, expected ${min}-${max}`);
  },
});

const cases: Case[] = [
  { name: 'enforce: signedUrl needs fs:share on the file', world: signedWorld(['fs:share']), steps: [as('alice', fsCall('uploads', 'signedUrl', [A], 'resolves'))] },
  { name: 'enforce: signedUrl without fs:share is AccessDenied, fs:read is not enough', world: signedWorld(['fs:read', 'fs:stat']), steps: [as('alice', fsCall('uploads', 'signedUrl', [A], DENIED))] },
  { name: 'enforce: getSignedUrl needs fs:share too', world: signedWorld(['fs:read']), steps: [as('alice', fsCall('uploads', 'getSignedUrl', [A], DENIED))] },
  { name: 'without an asked until the URL lives signedUrl.defaultTtlSeconds, 900 by default', world: signedWorld(['fs:share']), steps: [as('alice', lives('signedUrl', 890, 900), lives('getSignedUrl', 890, 900))] },
  { name: 'signedUrl.defaultTtlSeconds sets that lifetime', world: signedWorld(['fs:share'], { signedUrl: { defaultTtlSeconds: 300 } }), steps: [as('alice', lives('signedUrl', 290, 300))] },
  { name: 'signedUrl.maxTtlSeconds caps the URL below the default', world: signedWorld(['fs:share'], { signedUrl: { maxTtlSeconds: 60 } }), steps: [as('alice', lives('signedUrl', 50, 60), lives('getSignedUrl', 50, 60))] },
  { name: "the permit's validUntil caps the URL", world: signedWorld(['fs:share'], {}, 120), steps: [as('alice', lives('signedUrl', 110, 121))] },
];

export const B28SignedUrl = extension('B28', [
  {
    name: 'signedUrl',
    facets: ['engine', 'host', 'fs'],
    lanes: ['L7'],
    note: 'Proposed by RFC L7-1: signedUrl and getSignedUrl check fs:share, and the guard narrows the lifetime (design §13, D9). The provider spec flag `signedUrl` gives the provider a signer.',
    cases,
  },
]);
