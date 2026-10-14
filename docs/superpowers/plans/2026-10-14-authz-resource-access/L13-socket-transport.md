# Lane L13: socket transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `00-overview.md` in this folder first: its Global Constraints, Decisions and Frozen contracts bind this lane.

**Goal:** Push `authz.changed` (design §10.4) to socket clients of `@spinajs/http-socket`: every authenticated connection joins `principal:<principalKey>` when it connects, and `SocketAccessPushTransport implements AccessPushTransport` emits to those rooms (or to every connection for `'*'`).

**Architecture:** One new file `packages/http-socket/src/access-push.ts` holds a built-in socket controller with an `@OnConnect()` hook that joins the rooms, and the transport. `SocketHub` gains `toLocal(rooms)`, an emit that stays on this instance even with a socket.io adapter, because every node runs its own `AccessChangeRouter` on a cluster-wide ChangeBus and must reach only its own sockets.

**Tech Stack:** TypeScript (node16), socket.io 4, `@spinajs/di`, mocha + ts-mocha + chai 4 (+ chai-as-promised, sinon), the existing socket test harness `packages/http-socket/test/harness.ts`.

**Depends on:** L0 merged (`AccessPushTransport { abstract readonly name: string; abstract push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> }`, `AccessChangedEvent { objects?: readonly ResourceRef[] }` exported from `@spinajs/authz`). L2 Task 8 for `AUTHZ_CHANGED_EVENT = 'authz.changed'` (exported from `@spinajs/authz`). L2 Task 8 (`AccessChangeRouter`, which resolves `Array.chainOf(AccessPushTransport)` from the root container per change) feeds the transport in an app; this lane's tests call `push()` directly and do not need it.

**Blocks:** L9 (end-to-end push over the socket).

## Global Constraints

- All code, comments, identifiers and commit messages in English; comments only where a reader would ask "why?".
- Match the surrounding code: `@Injectable(Token)` / `@Singleton()`, `@Autoinject()`, `InvalidArgument` for a bad push target, push names validated by `assertPushName` (`sys.` is reserved; `authz.changed` matches `NAME_PATTERN = /^[\w.:-]+$/`).
- Tests: `packages/http-socket/test/<name>.test.ts`, run by `npm test` (`ts-mocha -p tsconfig.json test/*.test.ts` then the `test/authz/**` config). One file: `cd packages/http-socket && npx ts-mocha -p tsconfig.json test/<name>.test.ts`.
- `test/exports.test.ts` pins the runtime exports (`PUBLIC_API`, sorted by `Array.prototype.sort`) and the hub methods: every new export or hub method is added there on purpose.
- http-socket is not a snapshotted package (`scripts/api-snapshot.json` covers `auth[nz]*` only): no snapshot, no RFC.
- Commit after every task.

## Decisions made in this lane

1. **Always loaded with the package.** http-socket depends on `@spinajs/authz` directly (`package.json` dependencies) and registers its authz integration at import (`SocketAccessContributor` `@Injectable(AuthzContributor)`, `src/access-contributor.ts:11`). The new controller and transport follow the same rule: `src/index.ts` imports `access-push.ts`, so they exist whenever the package is imported. The transport is idle until the root domain's `AccessChangeRouter` routes a change, and a no-op while no connection is attached.
2. **Rooms.** `principal:<principalKey>` for the connection's principal and each of its `companions` (same keys as authz-http's SSE transport, `pushKeys`). Joined by the hook for a connection a `SocketPrincipalSource` authenticated (`connection.authenticated`) whose principal is authenticated (`principal.authenticated`), so `UNATTENDED` and anonymous connections join nothing and hear only `'*'`. A connection restored by connection-state recovery keeps its rooms (socket.io restores them) and its connect hooks run again (`SocketConnection.recovered` doc, `src/connection.ts:77-82`); joining twice is a no-op.
3. **`'*'` goes to every local connection** through `SocketConnection.emit`, which skips connections the principal guard is closing, not through a room: no room holds every socket, and `io.emit` would cross instances with an adapter.
4. **Local emit.** `SocketHub.toLocal(rooms)` uses `io.local.to(rooms)` and the same closing filter as `to()`. With a socket.io adapter, `to()` would deliver once per node, since every node routes the same change.
5. **A principal renewed by the guard** (`SocketPrincipalGuard.revalidate` may replace `auth.principal`, `src/principal-guard.ts:242-244`) keeps its rooms. Sources renew the same identity, so the room stays right; a source that swapped identities on revalidation would leave a stale room, which is out of scope (documented in the README).

## Files

- Modify: `packages/http-socket/src/hub.ts:63-78` (`to`), `:116-122` (`push`), add `toLocal`
- Create: `packages/http-socket/src/access-push.ts`
- Modify: `packages/http-socket/src/index.ts` (one export line)
- Modify: `packages/http-socket/test/hub.test.ts` (one case), `packages/http-socket/test/exports.test.ts` (`PUBLIC_API`, hub methods)
- Create: `packages/http-socket/test/access-push.test.ts`
- Modify: `packages/http-socket/README.md` ("Rooms and push", "Several instances")

---

### Task 1: `SocketHub.toLocal`

**Files:**
- Modify: `packages/http-socket/src/hub.ts`
- Test: `packages/http-socket/test/hub.test.ts`, `packages/http-socket/test/exports.test.ts`

**Interfaces:**
- Produces: `SocketHub.toLocal(room: string | string[]): ISocketEmitter` (same validation as `to()`: non-empty room names, attached hub).

- [ ] **Step 1: Write the failing tests**

In `packages/http-socket/test/hub.test.ts`, after the case `'pushes to a room only the connections that joined it'`, add:

```ts
  it('pushes to a room on this instance only with toLocal', async () => {
    resultOf(await command<string[]>(a, 'hub.join', { room: 'r3' }));
    const local = sinon.spy(t.server.Io!, 'local', ['get']);

    const missed = nextEvent(b, 'hub.local', 300);
    const received = nextEvent(a, 'hub.local');
    hub.toLocal('r3').emit('hub.local', { n: 1 });

    expect(await received).to.deep.equal({ n: 1 });
    await expect(missed).to.be.rejectedWith(/no hub.local event/);
    expect(local.get.called).to.equal(true);
    expect(() => hub.toLocal([])).to.throw(InvalidArgument, /non-empty/);
  });
```

In `packages/http-socket/test/exports.test.ts`, replace the hub method list in `'exposes the hub push API'`:

```ts
    for (const method of ['to', 'toLocal', 'toConnection', 'join', 'leave', 'connectionsIn', 'disconnect', 'connection']) {
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/http-socket && npx ts-mocha -p tsconfig.json test/hub.test.ts test/exports.test.ts`
Expected: FAIL with a TSError `Property 'toLocal' does not exist on type 'SocketHub'`.

- [ ] **Step 3: Implement**

In `packages/http-socket/src/hub.ts` replace `to` (lines 63-78) with:

```ts
  /** Rooms must be non-empty: socket.io treats an empty room set as every socket. */
  public to(room: string | string[]): ISocketEmitter {
    const rooms = this.rooms(room);

    return {
      emit: <P>(name: string, payload: P) => {
        assertPushName(name);
        this.push(rooms, name, payload, false);
      },
    };
  }

  /**
   * As `to()`, but only to this instance's connections even with an adapter: for a push every instance
   * makes itself, such as one routed from a cluster-wide ChangeBus, which `to()` would deliver once per instance.
   */
  public toLocal(room: string | string[]): ISocketEmitter {
    const rooms = this.rooms(room);

    return {
      emit: <P>(name: string, payload: P) => {
        assertPushName(name);
        this.push(rooms, name, payload, true);
      },
    };
  }
```

replace `push` (lines 116-122) with:

```ts
  protected push<P>(rooms: string[], name: string, payload: P, local: boolean): void {
    const frame: EventFrame<P> = { name, payload };
    const io = this.server();
    const target = local ? io.local.to(rooms) : io.to(rooms);
    const closing = this.Guard.ClosingIds;

    (closing.size > 0 ? target.except([...closing]) : target).emit(WIRE_EVENTS.event, frame);
  }

  protected rooms(room: string | string[]): string[] {
    this.server();

    const rooms = Array.isArray(room) ? room : [room];
    if (rooms.length === 0 || rooms.some((r) => typeof r !== 'string' || r.length === 0)) {
      throw new InvalidArgument('Push target must be a non-empty room name or a non-empty list of them');
    }

    return rooms;
  }
```

(`io.local.to()` and `io.to()` both return `BroadcastOperator<DecorateAcknowledgementsWithMultipleResponses<DefaultEventsMap>, any>`, so `target` has one type.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/http-socket && npx ts-mocha -p tsconfig.json test/hub.test.ts test/exports.test.ts`
Expected: PASS, `0 failing`. If sinon refuses to spy the `local` accessor (`Cannot spy non-existent property`), drop the two `local` lines: the behavioural assertions stay.

- [ ] **Step 5: Commit**

```bash
git add packages/http-socket/src/hub.ts packages/http-socket/test/hub.test.ts packages/http-socket/test/exports.test.ts
git commit -m "feat(http-socket): SocketHub.toLocal, room pushes that stay on this instance"
```

---

### Task 2: principal rooms and `SocketAccessPushTransport`

**Files:**
- Create: `packages/http-socket/src/access-push.ts`
- Modify: `packages/http-socket/src/index.ts`
- Modify: `packages/http-socket/test/exports.test.ts` (`PUBLIC_API`)
- Test: `packages/http-socket/test/access-push.test.ts`

**Interfaces:**
- Consumes: `AccessPushTransport`, `AccessChangedEvent`, `principalKey`, `AUTHZ_CHANGED_EVENT` from `@spinajs/authz`; `SocketHub.toLocal` (Task 1); `@SocketController`, `@OnConnect`, `@Connection` (`src/decorators.ts`); `SocketConnection.join`, `.emit`, `.authenticated`, `.principal`.
- Produces: `ACCESS_PUSH_ROOM_PREFIX = 'principal:'`, `principalRoom(principalKey: string): string`, `principalRooms(principal: Principal): string[]`, `@SocketController('authz') class AccessPushSocket` (connect hook `authz.joinPrincipalRooms`), `@Singleton() @Injectable(AccessPushTransport) class SocketAccessPushTransport { name = 'socket'; push(principals, event): Promise<void> }`.

- [ ] **Step 1: Write the failing test**

Create `packages/http-socket/test/access-push.test.ts` (`@spinajs/authz-testing` is already a devDependency):

```ts
import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AUTHZ_CHANGED_EVENT, AccessPushTransport } from '@spinajs/authz';
import { userPrincipal } from '@spinajs/authz-testing';
import { SocketHub } from '../src/hub.js';
import { SocketAccessPushTransport, principalRoom, principalRooms } from '../src/access-push.js';
import { ITestServer, delay, nextEvent, open, startServer } from './harness.js';

async function until(check: () => Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await delay(10);
  }
}

/** A transport over a hub that was never attached. */
class DetachedTransport extends SocketAccessPushTransport {
  constructor() {
    super();
    this.Hub = new SocketHub();
  }
}

describe('access push over sockets (design §10.4)', function () {
  this.timeout(15000);

  let t: ITestServer;
  let alice: ClientSocket;
  let guest: ClientSocket;
  let hub: SocketHub;
  let transport: SocketAccessPushTransport;

  beforeEach(async () => {
    t = await startServer();
    // 'good' is ALICE_PRINCIPAL (user:1) from the harness's TestPrincipalSource; no token is UNATTENDED
    alice = await open(t, { auth: { clientId: 'push-alice', token: 'good' } });
    guest = await open(t, { auth: { clientId: 'push-guest' } });
    hub = DI.resolve(SocketHub);
    transport = (await DI.resolve(SocketAccessPushTransport)) as SocketAccessPushTransport;
    await until(async () => (await hub.connectionsIn(principalRoom('user:1'))).includes(alice.id!));
  });

  afterEach(async () => {
    alice.close();
    guest.close();
    await t.close();
  });

  it('names the rooms of a principal and its companions', () => {
    expect(principalRoom('user:1')).to.equal('principal:user:1');
    expect(principalRooms(userPrincipal('7', { companions: [{ type: 'user', id: '8' }] }))).to.deep.equal(['principal:user:7', 'principal:user:8']);
  });

  it('joins an authenticated connection to principal:<principalKey> on connect, and an unauthenticated one to none', async () => {
    expect(await hub.connectionsIn('principal:user:1')).to.deep.equal([alice.id]);
    expect([...hub.connection(guest.id!)!.rooms].filter((r) => r.startsWith('principal:'))).to.deep.equal([]);
  });

  it('pushes authz.changed to the rooms of the named principals only', async () => {
    const missed = nextEvent(guest, AUTHZ_CHANGED_EVENT, 300);
    const received = nextEvent(alice, AUTHZ_CHANGED_EVENT);

    await transport.push(['user:1'], { objects: [{ type: 'doc', id: '1' }] });

    expect(await received).to.deep.equal({ objects: [{ type: 'doc', id: '1' }] });
    await expect(missed).to.be.rejectedWith(/no authz.changed event/);
  });

  it("pushes '*' to every connection of this instance", async () => {
    const toAlice = nextEvent(alice, AUTHZ_CHANGED_EVENT);
    const toGuest = nextEvent(guest, AUTHZ_CHANGED_EVENT);

    await transport.push('*', {});

    expect(await toAlice).to.deep.equal({});
    expect(await toGuest).to.deep.equal({});
  });

  it('pushes nothing for an empty list or a principal without a connection here', async () => {
    const missed = nextEvent(alice, AUTHZ_CHANGED_EVENT, 300);

    await transport.push([], {});
    await transport.push(['user:2'], {});

    await expect(missed).to.be.rejectedWith(/no authz.changed event/);
  });

  it('is the AccessPushTransport named socket the router finds', async () => {
    const transports = (await DI.resolve(Array.ofType(AccessPushTransport))) as AccessPushTransport[];
    expect(transports).to.include(transport);
    expect(transport.name).to.equal('socket');
  });

  it('is a no-op while its hub is not attached', async () => {
    await new DetachedTransport().push(['user:1'], {});
    await new DetachedTransport().push('*', {});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/http-socket && npx ts-mocha -p tsconfig.json test/access-push.test.ts`
Expected: FAIL with a TSError `Cannot find module '../src/access-push.js'`.

- [ ] **Step 3: Write the module**

Create `packages/http-socket/src/access-push.ts`:

```ts
import { Autoinject, Injectable, Singleton } from '@spinajs/di';
import { AUTHZ_CHANGED_EVENT, AccessPushTransport, principalKey } from '@spinajs/authz';
import type { AccessChangedEvent, Principal } from '@spinajs/authz';
import { BaseSocketController } from './controller.js';
import { Connection, OnConnect, SocketController } from './decorators.js';
import { SocketConnection } from './connection.js';
import { SocketHub } from './hub.js';

export const ACCESS_PUSH_ROOM_PREFIX = 'principal:';

export function principalRoom(key: string): string {
  return `${ACCESS_PUSH_ROOM_PREFIX}${key}`;
}

/** The principal's room and those of the identities that speak with it (a link bearer's signed-in user). */
export function principalRooms(principal: Principal): string[] {
  return [...new Set([principal, ...(principal.companions ?? [])].map((p) => principalRoom(principalKey(p))))];
}

@SocketController('authz')
export class AccessPushSocket extends BaseSocketController {
  @OnConnect()
  public joinPrincipalRooms(@Connection() connection: SocketConnection): void {
    if (!connection.authenticated || !connection.principal.authenticated) {
      return;
    }

    connection.join(principalRooms(connection.principal));
  }
}

/** `authz.changed` to socket clients (design §10.4); fed by the root domain's AccessChangeRouter. */
@Singleton()
@Injectable(AccessPushTransport)
export class SocketAccessPushTransport extends AccessPushTransport {
  public readonly name = 'socket';

  @Autoinject()
  protected Hub: SocketHub;

  public async push(principals: readonly string[] | '*', event: AccessChangedEvent): Promise<void> {
    // empty also while the hub is detached, when toLocal() would throw
    if (this.Hub.Connections.size === 0) {
      return;
    }

    if (principals === '*') {
      for (const connection of this.Hub.Connections.values()) {
        connection.emit(AUTHZ_CHANGED_EVENT, event);
      }
      return;
    }

    if (principals.length > 0) {
      this.Hub.toLocal(principals.map(principalRoom)).emit(AUTHZ_CHANGED_EVENT, event);
    }
  }
}
```

In `packages/http-socket/src/index.ts`, after line 25 (`export { SocketPrincipalGuard } from './principal-guard.js';`) add:

```ts
export { AccessPushSocket, SocketAccessPushTransport, principalRoom } from './access-push.js';
```

(`ACCESS_PUSH_ROOM_PREFIX` and `principalRooms` stay internal: apps address a principal with `principalRoom(principalKey(p))`.)

In `packages/http-socket/test/exports.test.ts`, add to `PUBLIC_API`, keeping the sort order:
- `'AccessPushSocket',` after `'AccessFieldsStage'`;
- `'SocketAccessPushTransport',` after `'SocketAccessPolicy'`;
- `'principalRoom',` after `'payloadSize'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/http-socket && npx ts-mocha -p tsconfig.json test/access-push.test.ts test/exports.test.ts`
Expected: PASS, `7 passing` in access-push, `0 failing`.

- [ ] **Step 5: Run the package suite for regressions (the hook now runs on every connection of every test file)**

Run: `cd packages/http-socket && npm test`
Expected: both mocha runs end with `0 failing`. Room assertions elsewhere use `include` (`test/events.test.ts`, `test/hub.test.ts`), so the extra `principal:user:1` room does not break them; the hook touches no `AuthzService`, so `test/authz-host.test.ts`'s note about connect hooks booting the root does not apply.

- [ ] **Step 6: Commit**

```bash
git add packages/http-socket/src/access-push.ts packages/http-socket/src/index.ts packages/http-socket/test/access-push.test.ts packages/http-socket/test/exports.test.ts
git commit -m "feat(http-socket): principal rooms on connect and SocketAccessPushTransport"
```

---

### Task 3: README and lane verification

**Files:**
- Modify: `packages/http-socket/README.md` (sections "Rooms and push" L214-224 and "Several instances" L335-337)

- [ ] **Step 1: Document**

In `packages/http-socket/README.md`, in "Rooms and push", after the bullet `- \`to(room | rooms).emit(name, payload)\`: every connection in the rooms` add:

```markdown
- `toLocal(room | rooms).emit(name, payload)`: the same, on this instance only, even with an adapter
```

and append to the end of that section:

```markdown
### Access change push

Every connection whose principal a source authenticated joins `principal:<principalKey>` (and the room of
each of its companions) when it connects; `principalRoom(principalKey(p))` names it. `SocketAccessPushTransport`
is an authz `AccessPushTransport`: the root domain's `AccessChangeRouter` hands it each change, and it emits
`authz.changed` with `{ objects?: [{ type, id }] }` to the affected principals' rooms, or to every connection
when a change concerns everyone. `objects` is present only when exact; without it a client refetches
everything. A source that renews a connection's principal must keep its identity: the rooms are joined once.
```

In "Several instances", append:

```markdown
Access change pushes are per node, on purpose: each node's `AccessChangeRouter` pushes to its own
connections, so an adapter does not deliver them twice. With several nodes, set
`authz.bus.service: 'QueueChangeBus'` (`@spinajs/authz-queue`) so every node sees every change; with the
in-process bus only clients connected to the node that made the change are told.
```

- [ ] **Step 2: Whole package and build**

Run: `cd packages/http-socket && npm test`
Expected: `0 failing` in both runs.

Run (repo root): `node node_modules/typescript-7/lib/tsc.js -b tsconfig.build.json`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/http-socket/README.md
git commit -m "docs(http-socket): access change push and local pushes"
```

---

## Contract issues found

None open. The event name (`AUTHZ_CHANGED_EVENT`, L2) and per-node push (overview decision 13) were settled in the overview.
