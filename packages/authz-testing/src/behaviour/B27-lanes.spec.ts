import assert from 'node:assert/strict';

import { GLOBAL, SYSTEM } from '@spinajs/authz';

import { userPrincipal } from '../principals.js';
import { combine, extension, permit, ref, role, staticModel } from './dsl.js';
import { eventually, laneHandle, versionAs, versionChanged } from './lane.js';
import { exec } from './model-steps.js';
import type { DoStep, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');

// rbac decides; m1 never votes and is there to observe invalidate().
const storeWorld: World = {
  permissions: ['file:read', 'file:write'],
  principals: { alice },
  combine: combine('deny-overrides', 'rbac', 'm1'),
  models: [staticModel('m1')],
  rbac: { roles: [role('editor', ['file:read', 'file:write'])] },
};

const GRANT = { kind: 'assignment.grant', subject: { type: 'user', id: 'alice' }, role: 'editor', scope: GLOBAL } as const;
const BROKEN = { kind: 'assignment.grant', subject: { type: 'user', id: 'alice' }, role: 'ghost', scope: GLOBAL } as const;

const invalidated = (expected: boolean): DoStep => ({
  note: `m1 ${expected ? 'was' : 'was not'} invalidated`,
  do: (ctx) => assert.equal(ctx.staticModel('m1').invalidations.length > 0, expected, `m1 invalidations ${JSON.stringify(ctx.staticModel('m1').invalidations)}`),
});

const write = { check: { as: 'alice', permission: 'file:write', resource: f1 } } as const;

const queueWorld: World = {
  permissions: ['file:read'],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { '*': permit() } })],
};

const TAG = 'subject:user:alice';

/** On the peer node: m1 received an invalidate() holding TAG. */
const peerInvalidated: DoStep = {
  note: 'the peer dropped subject:user:alice',
  do: async (ctx) => {
    const peer = await laneHandle(ctx, 'queue').peer();
    await eventually(() =>
      assert.ok(
        peer.kit.staticModel('m1').invalidations.some((tags) => tags.includes(TAG)),
        `peer m1 invalidations ${JSON.stringify(peer.kit.staticModel('m1').invalidations)}`,
      ),
    );
  },
};

/** On the peer node: the check of alice is answered, and m1 has evaluated it `calls` times in all. */
const peerCheck = (calls: number): DoStep => ({
  note: `peer check, m1 evaluated ${calls}`,
  do: async (ctx) => {
    const peer = await laneHandle(ctx, 'queue').peer();
    const run = async () => {
      const d = await peer.authz.check({ principal: alice, permission: 'file:read', resource: f1 });
      assert.equal(d.allowed, true, 'peer check');
      assert.equal(peer.kit.staticModel('m1').requests.length, calls, 'peer m1 evaluations');
    };
    if (calls > 1) await eventually(run);
    else await run();
  },
});

export const B27Lanes = extension('B27', [
  {
    name: 'store',
    facets: ['engine', 'rbac', 'store', 'bus', 'admin', 'cache'],
    lanes: ['L2'],
    note: 'Stores write only inside an AuthzAdmin transaction (design §6.6.2, §9.2); the tags of the change are not asserted (D-F5-4).',
    world: storeWorld,
    cases: [
      {
        name: 'a store write bumps authz_version(domain), publishes after commit and drops cached decisions and model entries',
        steps: [{ ...write, expect: { allowed: false } }, versionAs('v'), exec(SYSTEM, [GRANT], 'ok'), versionChanged('v', true), { published: { tags: [], count: 1 } }, invalidated(true), { ...write, expect: { allowed: true } }],
      },
      {
        name: 'a batch that fails rolls back: no version bump, nothing published',
        steps: [versionAs('v'), exec(SYSTEM, [GRANT, BROKEN], { failsAt: 1 }), versionChanged('v', false), { published: { tags: [], count: 0 } }, { ...write, expect: { allowed: false } }],
      },
    ],
  },
  {
    name: 'queue',
    facets: ['engine', 'bus', 'cache', 'queue'],
    lanes: ['L6'],
    note: 'QueueChangeBus (design §14.2): session.bus publishes on this node; queue.peer() is a second node on the same transport.',
    world: queueWorld,
    cases: [
      { name: "a change published on one node reaches the other node's models", steps: [{ publish: { tags: [TAG] } }, peerInvalidated] },
      { name: "a change published on one node drops the other node's L2 entries", steps: [peerCheck(1), peerCheck(1), { publish: { tags: [TAG] } }, peerCheck(2)] },
    ],
  },
]);
