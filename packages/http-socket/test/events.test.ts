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
import { MAX_NAME_LENGTH, SYSTEM_EVENTS, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, OnConnect, OnDisconnect, OnEvent, Payload, Reason, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketAccess } from '../src/access.js';
import { SocketConnection } from '../src/connection.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { SocketPrincipalGuard } from '../src/principal-guard.js';
import { ISocketCallStorage, ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { IConnectOptions, ITestServer, command, delay, errorOf, nextEvent, open, resultOf, startServer, waitFor } from './harness.js';

export const evtLog: Array<{ name: string; payload?: unknown; connection: string }> = [];

export const evtRevoked = new Set<string>();

/** `${principal id}|${permission}` */
export const evtAllowed = new Set<string>();

/** `evt.slow` holds until `release()` */
export const evtSlow = { active: 0, max: 0, started: 0, gate: Promise.resolve(), release: () => undefined as void };

const holdSlow = () => {
  Object.assign(evtSlow, { active: 0, max: 0, started: 0 });
  evtSlow.gate = new Promise<void>((resolve) => {
    evtSlow.release = resolve;
  });
};

/** the `hang` connect hook of 'evt-hang' clients holds until `release()` */
export const evtHang = { gate: Promise.resolve(), release: () => undefined as void };

const holdHang = () => {
  evtHang.gate = new Promise<void>((resolve) => {
    evtHang.release = resolve;
  });
};

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

  @OnEvent('slow')
  public async slow(): Promise<void> {
    evtSlow.started++;
    evtSlow.max = Math.max(evtSlow.max, ++evtSlow.active);
    try {
      await evtSlow.gate;
    } finally {
      evtSlow.active--;
    }
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

  @OnConnect()
  public async hang(@Connection() conn: SocketConnection): Promise<void> {
    if (conn.clientId === 'evt-hang') {
      await evtHang.gate;
    }
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
  type Level = 'warn' | 'debug' | 'error';
  let spies: Record<Level, sinon.SinonSpy> | null = null;

  const boot = async (cfg: Record<string, unknown> = {}) => {
    t = await startServer(cfg);
    const log = (DI.resolve(SocketDispatcher) as unknown as { Log: Record<Level, (...a: unknown[]) => void> }).Log;
    spies = { warn: sinon.spy(log, 'warn'), debug: sinon.spy(log, 'debug'), error: sinon.spy(log, 'error') };
  };

  /** the message of every `level` line logged so far */
  const lines = (level: Level) => spies![level].getCalls().map((c) => String(c.args.find((a) => typeof a === 'string')));

  /** waits until the dispatcher logged a line matching `pattern` at `level` */
  const logged = (pattern: RegExp, level: Level = 'warn') => waitFor(() => lines(level).some((l) => pattern.test(l)));

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
    Object.values(spies ?? {}).forEach((spy) => spy.restore());
    spies = null;
    evtHang.release();
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
      await logged(new RegExp(`evt\\.read from connection ${anonymous.id} dropped: unauthenticated`), 'debug');
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

  it('answers commands on time while a connect hook hangs: deadline, cancel and the limits do not wait for the hooks', async () => {
    holdHang();
    await start({ http: { socket: { maxPayloadBytes: 200, maxInFlightPerConnection: 1 } } }, { auth: { clientId: 'evt-hang' } });

    for (let n = 0; n < 2; n++) {
      // the second one only gets the in-flight slot when the first gave it back on its deadline
      const t0 = Date.now();
      expect(errorOf(await command(socket, 'evt.rooms', null, { deadline: 100 })).code).to.equal('deadline_exceeded');
      expect(Date.now() - t0).to.be.lessThan(1000);
    }

    const pending = command(socket, 'evt.rooms', null, { id: 'evt-hang-cancel' });
    await delay(50);
    expect(errorOf(await command(socket, 'evt.rooms'))).to.include({ code: 'resource_exhausted', message: 'more than 1 commands in flight on this connection' });
    expect(errorOf(await command(socket, 'evt.rooms', 'x'.repeat(300))).message).to.match(/^payload of \d+ bytes exceeds the limit of 200 bytes$/);

    socket.emit(WIRE_EVENTS.cancel, { id: 'evt-hang-cancel' });
    expect(errorOf(await pending).code).to.equal('cancelled');
  });

  it('stops waiting for the connect hooks after http.socket.hooks.connectTimeoutMs, with an error log', async () => {
    holdHang();
    await start({ http: { socket: { hooks: { connectTimeoutMs: 200 } } } }, { auth: { clientId: 'evt-hang' } });

    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
    expect(lines('error')).to.include(`Socket connect hooks of connection ${socket.id} still running after 200 ms; its commands and events no longer wait for them`);
  });

  it('logs a failure of the disconnect hook chain instead of leaving it unhandled', async () => {
    await start();
    const id = socket.id!;
    const registry = (DI.resolve(SocketDispatcher) as unknown as { Registry: SocketHandlerRegistry }).Registry;
    const hooks = sinon.stub(registry, 'hooks').callsFake((kind) => {
      if (kind === 'disconnect') {
        throw new Error('registry gone');
      }
      return hooks.wrappedMethod.call(registry, kind);
    });

    try {
      socket.disconnect();
      await logged(new RegExp(`Socket disconnect hooks of connection ${id} failed`), 'error');
    } finally {
      hooks.restore();
    }
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
    await logged(/evt\.cursor .* dropped: resource_exhausted payload of \d+ bytes exceeds the limit of 200 bytes/, 'debug');

    expect(seen('cursor', socket.id!)).to.have.length(0);
    expect(socket.connected).to.be.true;
  });

  it('logs 200 events over the rate limit at debug, not one warn each', async () => {
    await start({ http: { socket: { rate: { perSecond: 1, burst: 2 } } } });
    const id = socket.id!;
    for (let x = 0; x < 200; x++) {
      socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x } });
    }

    await waitFor(() => lines('debug').filter((l) => l.startsWith(`Socket event evt.cursor from connection ${id} dropped: resource_exhausted`)).length === 198);
    expect(lines('warn').filter((l) => l.startsWith('Socket event') && l.includes(id))).to.have.length.at.most(1);
  });

  it('warns about other refused events at most once per connection in a window, and logs the rest at debug', async () => {
    await start({ http: { socket: { maxInFlightEventsPerConnection: 1000, rate: { perSecond: 1000, burst: 1000 } } } });
    const id = socket.id!;
    const forbidden = (l: string) => l.startsWith(`Socket event evt.guarded from connection ${id} dropped: forbidden`);
    for (let x = 0; x < 200; x++) {
      socket.emit(WIRE_EVENTS.event, { name: 'evt.guarded', payload: null });
    }

    await waitFor(() => lines('warn').filter(forbidden).length + lines('debug').filter(forbidden).length === 200);
    expect(lines('warn').filter((l) => l.startsWith('Socket event') && l.includes(id))).to.have.length(1);
  });

  it('lets a burst of 100 instant events through the default caps', async () => {
    await start();
    for (let x = 0; x < 100; x++) {
      socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x } });
    }

    await waitFor(() => seen('cursor', socket.id!).length === 100);
    expect(lines('debug').filter((l) => l.includes('dropped'))).to.deep.equal([]);
  });

  it('caps running events with maxInFlightEventsPerConnection, apart from the command slots', async () => {
    holdSlow();
    await start({ http: { socket: { maxInFlightPerConnection: 1, maxInFlightEventsPerConnection: 2, rate: { perSecond: 1000, burst: 2 } } } });
    const id = socket.id!;
    try {
      for (let x = 0; x < 5; x++) {
        socket.emit(WIRE_EVENTS.event, { name: 'evt.slow', payload: null });
        await delay(10);
      }

      const dropped = () => lines('debug').filter((l) => l.startsWith(`Socket event evt.slow from connection ${id} dropped: resource_exhausted`));
      await waitFor(() => dropped().length === 3);
      expect(dropped().every((l) => l.includes('more than 2 events in flight on this connection'))).to.equal(true);
      expect(dropped().some((l) => l.includes('rate limit exceeded'))).to.equal(false);
      await waitFor(() => evtSlow.active === 2);
      expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
    } finally {
      evtSlow.release();
    }

    await waitFor(() => evtSlow.active === 0);
    expect(evtSlow).to.include({ max: 2, started: 2 });
  });

  it('frees the slots of events waiting for the connect hooks when the connection closes, and never runs them', async () => {
    holdHang();
    await start({}, { auth: { clientId: 'evt-hang' } });
    const id = socket.id!;
    const runtime = (DI.resolve(SocketDispatcher) as unknown as { runtimes: Map<string, { eventsInFlight: number }> }).runtimes.get(id)!;
    for (let x = 0; x < 3; x++) {
      socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x } });
    }
    await waitFor(() => runtime.eventsInFlight === 3);

    socket.disconnect();
    await waitFor(() => runtime.eventsInFlight === 0);
    evtHang.release();
    await delay(100);

    expect(seen('cursor', id)).to.have.length(0);
    expect(lines('warn').filter((l) => l.startsWith('Socket event') && l.includes(id))).to.deep.equal([]);
  });

  it('does not log a still-running connect hook for a connection that already left', async () => {
    holdHang();
    await start({ http: { socket: { hooks: { connectTimeoutMs: 200 } } } }, { auth: { clientId: 'evt-hang' } });
    const id = socket.id!;
    socket.disconnect();
    await delay(400);

    expect(lines('error').filter((l) => l.includes(id))).to.deep.equal([]);
  });

  it('refuses command and event names longer than MAX_NAME_LENGTH or outside NAME_PATTERN', async () => {
    await start();
    const names = ['evt.' + 'x'.repeat(MAX_NAME_LENGTH - 3), 'evt.rooms\n'];

    for (const name of names) {
      expect(errorOf(await command(socket, name))).to.deep.equal({ code: 'invalid_argument', message: 'malformed command request', retryable: false });
      socket.emit(WIRE_EVENTS.event, { name, payload: null });
    }

    await waitFor(() => lines('debug').filter((l) => l === `Malformed socket event from connection ${socket.id}, dropped`).length === names.length);
    expect(lines('debug').filter((l) => l.startsWith('Unknown socket event'))).to.deep.equal([]);
    expect(resultOf(await command(socket, 'evt.rooms'))).to.include('evt-lobby');
  });

  it('rate-limits events with the connection bucket', async () => {
    await start({ http: { socket: { rate: { perSecond: 1, burst: 2 } } } });
    for (let x = 0; x < 5; x++) {
      socket.emit(WIRE_EVENTS.event, { name: 'evt.cursor', payload: { x } });
    }
    await logged(/evt\.cursor .* dropped: resource_exhausted rate limit exceeded/, 'debug');
    await delay(50);

    expect(seen('cursor', socket.id!).map((e) => (e.payload as { x: number }).x)).to.deep.equal([0, 1]);
    expect(socket.connected).to.be.true;
  });
});
