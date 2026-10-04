import 'mocha';
import assert from 'node:assert/strict';
import { SYSTEM, authz } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AuthzQueueHook } from '@spinajs/authz-queue';
import { BEHAVIOUR_FIXTURES, fixtureDsl, laneSteps, runBehaviour, userPrincipal } from '@spinajs/authz-testing';
import type { FixturePart, OrmModelSpec, StepContext, World } from '@spinajs/authz-testing';
import type { SocketResult } from './socket-harness.js';
import { socketHarness } from './socket-harness.js';

const { combine, extension, permit, relation, staticModel } = fixtureDsl;
const { as, laneCall, laneHandle } = laneSteps;

// Own cases beside the kit's: the explicit system path, a connection with a user principal, a
// principal source that yields SYSTEM, and the L6 rule that an unattended emitter stamps no Initiator.

const TASK: OrmModelSpec = {
  name: 'Task',
  type: 'task',
  owner: 'owner',
  columns: ['title', 'owner'],
  rows: [
    { id: 't1', title: 'a', owner: 'alice' },
    { id: 't2', title: 'b', owner: 'bob' },
    { id: 't3', title: 'c', owner: 'alice' },
  ],
};
const SELECT = { op: 'select', model: 'Task' } as const;
const AUDIT = { audit: { denials: true, runAs: true, unscoped: true } } as const;
const NOT_CALLED = { calls: { model: 'm1', count: 0 } } as const;
const UNATTENDED_DENIED = { throws: 'AccessDenied', reason: 'unattended' } as const;

const world: World = {
  permissions: [],
  principals: { alice: userPrincipal('alice'), bob: userPrincipal('bob') },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { 'task:read': permit(relation('owner')) } })],
  config: AUDIT,
  lane: {
    orm: { models: [TASK] },
    socket: {
      handlers: [
        { event: 'tasks', orm: SELECT },
        { event: 'tasks.system', orm: SELECT },
      ],
    },
  },
};

const emits = (event: string, principal: SocketResult['principal'], ids: readonly string[]) => ({
  note: `emit ${event} sees ${ids.join(', ') || 'nothing'} as ${principal.type}:${principal.id}`,
  do: async (ctx: StepContext) => {
    const r = (await laneHandle(ctx, 'socket').emit(event)) as SocketResult;
    assert.deepEqual(r.principal, principal, `emit ${event}: the handler's principal`);
    assert.deepEqual([...r.ids].sort(), [...ids].sort(), `emit ${event}: ids`);
  },
});

const stamps = (initiator: unknown) => ({
  note: `emit stamp: Initiator ${JSON.stringify(initiator)}`,
  do: async (ctx: StepContext) => assert.deepEqual(await laneHandle(ctx, 'socket').emit('stamp'), { initiator }, 'the queue message Initiator'),
});

const systemPart: FixturePart = {
  name: 'socket-system',
  facets: ['engine', 'host', 'audit', 'orm', 'socket'],
  lanes: ['C9'],
  world,
  cases: [
    {
      name: "an unattended socket handler that runs its query under runAs(SYSTEM, reason) gets every row, consults no model, and the bypass is audited",
      steps: [emits('tasks.system', { type: 'unattended', id: 'unattended' }, ['t1', 't2', 't3']), NOT_CALLED, { audit: { kind: 'runAs', reason: 'socket-test' } }],
    },
    { name: 'without runAs the same unattended handler is denied', steps: [laneCall('emit tasks', (ctx) => laneHandle(ctx, 'socket').emit('tasks'), UNATTENDED_DENIED), NOT_CALLED] },
  ],
};

const userPart: FixturePart = {
  name: 'socket-user',
  facets: ['engine', 'host', 'orm', 'socket'],
  lanes: ['C9'],
  world,
  cases: [
    { name: "a connection whose SocketPrincipalSource yields alice runs the handler as alice and sees alice's rows", steps: [as('alice', emits('tasks', { type: 'user', id: 'alice' }, ['t1', 't3']))] },
    { name: "bob's connection sees bob's rows", steps: [as('bob', emits('tasks', { type: 'user', id: 'bob' }, ['t2']))] },
  ],
};

const FORGED_SYSTEM: Principal = { type: 'system', id: 'forged', authenticated: true, source: 'behaviour', attributes: {} };
const FORGED_UNATTENDED: Principal = { type: 'unattended', id: 'forged', authenticated: false, source: 'behaviour', attributes: {} };

const refused = {
  note: 'the handshake is refused (internal) and no handler runs',
  do: async (ctx: StepContext) => {
    await assert.rejects(laneHandle(ctx, 'socket').emit('tasks'), (e: Error & { code?: string }) => e.name === 'SocketException' && e.code === 'internal');
  },
};

/** As authz-http's PrincipalMiddleware (design §14.1): SYSTEM and UNATTENDED come only from runAs, never from a credential. */
const sourcePart: FixturePart = {
  name: 'socket-source',
  facets: ['engine', 'host', 'orm', 'socket'],
  lanes: ['C9'],
  world,
  cases: [
    { name: 'a principal source that yields SYSTEM refuses the connection', steps: [{ runAs: { as: SYSTEM, reason: 'client' }, steps: [refused] }] },
    { name: 'so does one that yields a system-typed principal', steps: [{ runAs: { as: FORGED_SYSTEM, reason: 'client' }, steps: [refused] }] },
    { name: 'and one that yields an unattended-typed principal', steps: [{ runAs: { as: FORGED_UNATTENDED, reason: 'client' }, steps: [refused] }] },
  ],
};

/** L6 (design §14.1): AuthzQueueHook.beforeEmit in the socket handler's store, on the test domain. */
class DomainQueueHook extends AuthzQueueHook {
  constructor(private readonly domain: string) {
    super();
  }

  protected async service() {
    return authz(this.domain);
  }
}

const queuePart: FixturePart = {
  name: 'socket-queue',
  facets: ['engine', 'host', 'orm', 'socket'],
  lanes: ['C9', 'L6'],
  world,
  cases: [
    { name: 'a queue message emitted from an unattended socket handler carries no Initiator', steps: [stamps(null)] },
    { name: "one emitted from alice's connection is stamped with alice", steps: [as('alice', stamps({ type: 'user', id: 'alice' }))] },
  ],
};

const stamp = async (domain: string) => {
  const message = { Name: 'probe' } as unknown as Parameters<AuthzQueueHook['beforeEmit']>[0];
  await new DomainQueueHook(domain).beforeEmit(message);
  return { initiator: (message as { Initiator?: unknown }).Initiator ?? null };
};

// One harness and one server for the kit's part and the own ones.
runBehaviour(['B09.socket', 'B09.socket-system', 'B09.socket-user', 'B09.socket-source', 'B09.socket-queue'], () => socketHarness({ asSystem: ['tasks.system'], commands: { stamp } }), {
  strict: true,
  fixtures: [...BEHAVIOUR_FIXTURES, extension('B09', [systemPart, userPart, sourcePart, queuePart])],
});
