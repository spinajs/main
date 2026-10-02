import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { AuthenticationFailed, Forbidden } from '@spinajs/exceptions';
import { BasePolicy } from '@spinajs/http';
import { AuthzDomains, AuthzService, FALSE, TRUE } from '@spinajs/authz';
import type { AccessSummary, AuthorizationModel, AuthzAdmin, CheckInput, Decision, Permission, Principal, ResourceFilter, ResourceRef } from '@spinajs/authz';
import { SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnConnect, OnDisconnect, OnEvent, Payload, Reason, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess } from '../src/access.js';
import { SocketConnection } from '../src/connection.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { SocketPrincipalGuard } from '../src/principal-guard.js';
import { ISocketCallStorage, ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { IConnectOptions, ITestServer, command, delay, nextEvent, open, resultOf, startServer, waitFor } from './harness.js';

export const evtLog: Array<{ name: string; payload?: unknown; connection: string }> = [];

export const evtRevoked = new Set<string>();

/** `${principal id}|${permission}` */
export const evtAllowed = new Set<string>();

const store = () => (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();

/** The hooks below act only on this file's connections: every registered controller's hooks run for every connection of the suite. */
const ours = (conn: SocketConnection) => conn.clientId.startsWith('evt-');

/** Owns the tokens starting with 'evtauth-'. */
export class EvtAuthSource extends SocketPrincipalSource {
  public readonly name = 'evt-auth';
  public readonly order = 5;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('evtauth-')) {
      return null;
    }

    if (evtRevoked.has(token)) {
      throw new AuthenticationFailed('revoked');
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {} };
  }
}

DI.register(EvtAuthSource).as(SocketPrincipalSource);

function unused(member: string): never {
  throw new Error(`EvtTestAuthz.${member} is not used by socket tests`);
}

/** A scripted AuthzService: the F4 host and the F3 engine have not merged. */
export class EvtTestAuthz extends AuthzService {
  public readonly domain = 'root';

  public async check(input: CheckInput): Promise<Decision> {
    const resource = input.resource as ResourceRef;
    const allowed = evtAllowed.has(`${input.principal.id}|${input.permission}`);

    return {
      allowed,
      permission: input.permission,
      resource,
      principal: { type: input.principal.type, id: input.principal.id },
      residual: allowed ? TRUE : FALSE,
      fields: { read: [], write: [] },
      roles: {},
      domain: 'root',
      ...(allowed ? {} : { reason: { code: 'no_access', model: 'm1', priority: 400, sortKey: 'm1' } }),
    };
  }

  public current(): Principal {
    return unused('current');
  }
  public runAs<T>(): Promise<T> {
    return unused('runAs');
  }
  public can(): Promise<boolean> {
    return unused('can');
  }
  public assert(): Promise<Decision> {
    return unused('assert');
  }
  public checkMany(): Promise<ReadonlyMap<Permission, Decision>> {
    return unused('checkMany');
  }
  public filter(): Promise<ResourceFilter> {
    return unused('filter');
  }
  public filterNow(): ResourceFilter | undefined {
    return unused('filterNow');
  }
  public explain(): Promise<Decision> {
    return unused('explain');
  }
  public summary(): Promise<AccessSummary> {
    return unused('summary');
  }
  public covers(): Promise<boolean> {
    return unused('covers');
  }
  public preload(): Promise<void> {
    return unused('preload');
  }
  public invalidate(): void {
    unused('invalidate');
  }
  public models(): readonly AuthorizationModel[] {
    return unused('models');
  }
  public admin(): AuthzAdmin {
    return unused('admin');
  }
}

export class EvtTestDomains extends AuthzDomains {
  public service(): AuthzService {
    return new EvtTestAuthz();
  }
  public create(): IContainer {
    return unused('create');
  }
  public container(): IContainer {
    return unused('container');
  }
  public names(): readonly string[] {
    return ['root'];
  }
}

export class EvtDeny extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    throw new Forbidden('no');
  }
}

/** Records whether the policy ran inside the call's store. */
export class EvtStoreProbe extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {
    evtLog.push({ name: 'probe-policy', payload: store()?.socketCall ?? null, connection: store()?.connectionId as string });
  }
}

@SocketController('evt')
export class EventSocket extends BaseSocketController {
  @OnEvent('cursor', { schema: { type: 'object', required: ['x'], properties: { x: { type: 'number' } } } })
  public async cursor(@Payload() at: { x: number }, @Connection() conn: SocketConnection) {
    evtLog.push({ name: 'cursor', payload: at, connection: conn.id });
  }

  @OnEvent('explode')
  public async explode(): Promise<void> {
    throw new Error('event handler failure');
  }

  @OnEvent('guarded')
  @SocketPolicy(EvtDeny)
  public async guarded(@Connection() conn: SocketConnection) {
    evtLog.push({ name: 'guarded', connection: conn.id });
  }

  @OnEvent('read')
  @SocketAccess('doc:read')
  public async read(@Connection() conn: SocketConnection) {
    evtLog.push({ name: 'read', payload: store()?.AuthzDecision?.permission ?? null, connection: conn.id });
  }

  @OnEvent('whoami')
  @SocketPolicy(EvtStoreProbe)
  public async whoami(@Connection() conn: SocketConnection) {
    const s = store();
    evtLog.push({ name: 'whoami', payload: { principal: s?.Principal.id ?? null, authn: s?.AuthnPrincipal?.id ?? null, call: s?.socketCall ?? null }, connection: conn.id });
  }

  // declared before `joined`: a failing hook must not stop the hooks after it
  @OnConnect()
  public async failing(@Connection() conn: SocketConnection): Promise<void> {
    if (ours(conn)) {
      throw new Error('connect hook failure');
    }
  }

  @OnConnect()
  public async joined(@Connection() conn: SocketConnection) {
    if (!ours(conn)) {
      return;
    }

    await delay(20);
    conn.join('evt-lobby');
    evtLog.push({ name: 'connect', payload: store()?.Principal.id ?? null, connection: conn.id });
  }

  @OnDisconnect()
  public async left(@Connection() conn: SocketConnection, @Reason() reason: string) {
    if (ours(conn)) {
      evtLog.push({ name: 'disconnect', payload: { reason, principal: store()?.Principal.id ?? null }, connection: conn.id });
    }
  }

  @Command('rooms')
  public async rooms(@Connection() conn: SocketConnection) {
    return [...conn.rooms];
  }
}

const seen = (name: string, connection: string) => evtLog.filter((e) => e.name === name && e.connection === connection);

describe('socket events and lifecycle hooks', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;
  let warn: sinon.SinonSpy | null = null;

  const boot = async (cfg: Record<string, unknown> = {}) => {
    t = await startServer(cfg);
    warn = sinon.spy((DI.resolve(SocketDispatcher) as unknown as { Log: { warn: (...a: unknown[]) => void } }).Log, 'warn');
  };

  /** waits until the dispatcher logged a dropped call matching `pattern` */
  const logged = (pattern: RegExp) => waitFor(() => warn!.getCalls().some((c) => pattern.test(String(c.args.find((a) => typeof a === 'string')))));

  const connectAs = (options: IConnectOptions = {}) => open(t, { ...options, auth: { clientId: 'evt-client', ...options.auth } });

  const start = async (cfg: Record<string, unknown> = {}, options: IConnectOptions = {}) => {
    await boot(cfg);
    socket = await connectAs(options);
  };

  before(() => {
    DI.register(EvtTestAuthz).as(AuthzService);
    DI.register(EvtTestDomains).as(AuthzDomains);
  });

  after(() => {
    DI.unregister(EvtTestAuthz);
    DI.unregister(EvtTestDomains);
  });

  afterEach(async () => {
    warn?.restore();
    warn = null;
    evtAllowed.clear();
    socket.close();
    await t.close();
  });

  it('delivers a client event to its handler', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x: 3 } });

    await waitFor(() => seen('cursor', socket.id!).length === 1);
    expect(seen('cursor', socket.id!)[0].payload).to.deep.equal({ x: 3 });
  });

  it('drops an event whose payload fails validation and keeps the socket', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: {} });
    await delay(100);

    expect(seen('cursor', socket.id!)).to.have.length(0);
    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
  });

  it('survives a throwing handler, an unknown event and a malformed frame, and logs the handler failure', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.explode', payload: null });
    socket.emit(WIRE_EVENTS.event, { name: 'evt.unknown', payload: null });
    socket.emit(WIRE_EVENTS.event, 'not a frame');
    await logged(/evt\.explode .* dropped: internal event handler failure/);

    expect(socket.connected).to.be.true;
    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
  });

  it('applies policies to events', async () => {
    await start();
    socket.emit(WIRE_EVENTS.event, { name: 'evt.guarded', payload: null });
    await logged(/evt\.guarded .* dropped: forbidden/);

    expect(seen('guarded', socket.id!)).to.have.length(0);
    expect(socket.connected).to.be.true;
  });

  it('applies @SocketAccess to events: anonymous and denied principals never reach the handler, an allowed one does', async () => {
    await boot();
    const anonymous = await connectAs();
    socket = await connectAs({ auth: { clientId: 'evt-alice', token: 'evtauth-alice' } });

    try {
      anonymous.emit(WIRE_EVENTS.event, { name: 'evt.read', payload: null });
      await logged(new RegExp(`evt\\.read from connection ${anonymous.id} dropped: unauthenticated`));
      socket.emit(WIRE_EVENTS.event, { name: 'evt.read', payload: null });
      await logged(new RegExp(`evt\\.read from connection ${socket.id} dropped: forbidden`));

      expect(seen('read', anonymous.id!)).to.have.length(0);
      expect(seen('read', socket.id!)).to.have.length(0);
      expect(anonymous.connected && socket.connected).to.be.true;

      evtAllowed.add('evtauth-alice|doc:read');
      socket.emit(WIRE_EVENTS.event, { name: 'evt.read', payload: null });

      await waitFor(() => seen('read', socket.id!).length === 1);
      expect(seen('read', socket.id!)[0].payload).to.equal('doc:read');
    } finally {
      anonymous.close();
    }
  });

  it('runs event policies, event handlers and hooks inside the call store with the connection principal (D14)', async () => {
    await start({}, { auth: { token: 'evtauth-who' } });
    const id = socket.id!;

    await waitFor(() => seen('connect', id).length === 1);
    expect(seen('connect', id)[0].payload).to.equal('evtauth-who');

    socket.emit(WIRE_EVENTS.event, { name: 'evt.whoami', payload: null });
    await waitFor(() => seen('whoami', id).length === 1);

    expect(seen('probe-policy', id)[0].payload).to.equal('evt.whoami');
    expect(seen('whoami', id)[0].payload).to.deep.equal({ principal: 'evtauth-who', authn: 'evtauth-who', call: 'evt.whoami' });

    socket.disconnect();
    await waitFor(() => seen('disconnect', id).length === 1);
    expect((seen('disconnect', id)[0].payload as { principal: string }).principal).to.equal('evtauth-who');
  });

  it('finishes the connect hooks before the first command and survives a failing hook', async () => {
    await start();

    expect(socket.connected).to.be.true;
    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
  });

  it('runs the disconnect hooks with the reason', async () => {
    await start();
    const id = socket.id!;
    socket.disconnect();

    await waitFor(() => seen('disconnect', id).length === 1);
    expect((seen('disconnect', id)[0].payload as { reason: string }).reason).to.equal('client namespace disconnect');
  });

  it('drops events from a connection whose credentials stopped working, and closes it (D16)', async () => {
    await boot({ http: { socket: { auth: { revalidateMs: 50 } } } });
    // the sweep is stopped: only the event path can notice the revocation
    (DI.resolve(SocketPrincipalGuard) as SocketPrincipalGuard).stop();
    socket = await connectAs({ auth: { token: 'evtauth-a' } });
    const id = socket.id!;

    evtRevoked.add('evtauth-a');
    await delay(80);
    const notice = nextEvent(socket, SYSTEM_EVENTS.disconnect);
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x: 9 } });

    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    await waitFor(() => !socket.connected);
    expect(seen('cursor', id)).to.have.length(0);
  });

  it('drops an oversized event', async () => {
    await start({ http: { socket: { maxPayloadBytes: 200 } } });
    socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x: 1, pad: 'x'.repeat(300) } });
    await logged(/evt\.cursor .* dropped: resource_exhausted payload of \d+ bytes exceeds the limit of 200 bytes/);

    expect(seen('cursor', socket.id!)).to.have.length(0);
    expect(socket.connected).to.be.true;
  });

  it('rate-limits events with the connection bucket', async () => {
    await start({ http: { socket: { rate: { perSecond: 1, burst: 2 } } } });
    for (let x = 0; x < 5; x++) {
      socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x } });
    }
    await logged(/evt\.cursor .* dropped: resource_exhausted rate limit exceeded/);
    await delay(50);

    expect(seen('cursor', socket.id!).map((e) => (e.payload as { x: number }).x)).to.deep.equal([0, 1]);
    expect(socket.connected).to.be.true;
  });
});
