import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import type { Principal } from '@spinajs/authz';
import { PROTOCOL_VERSION, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnEvent, SocketController } from '../src/decorators.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { SocketHub } from '../src/hub.js';
import { ISocketHandshake, ISocketRevalidation, SocketPrincipalSource, SocketRevalidationResult } from '../src/interfaces.js';
import { SocketPrincipalGuard } from '../src/principal-guard.js';
import { ITestServer, command, connect, connected, errorOf, nextEvent, open, resultOf, startServer, waitFor } from './harness.js';

/** Owns the tokens starting with 'activity-'; records the check each revalidate() gets and answers from `answers` ( 'valid' when empty ) once `gate` settles. */
export class ActivityScriptedSource extends SocketPrincipalSource {
  public static checks: Array<ISocketRevalidation | undefined> = [];
  public static answers: SocketRevalidationResult[] = [];
  public static gate: Promise<void> | null = null;

  public static reset(): void {
    ActivityScriptedSource.checks = [];
    ActivityScriptedSource.answers = [];
    ActivityScriptedSource.gate = null;
  }

  public readonly name = 'activity';
  public readonly order = 6;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('activity-')) {
      return null;
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {} };
  }

  public async revalidate(_handshake: ISocketHandshake, _principal: Principal, check?: ISocketRevalidation): Promise<SocketRevalidationResult> {
    ActivityScriptedSource.checks.push(check);
    if (ActivityScriptedSource.gate) {
      await ActivityScriptedSource.gate;
    }
    return ActivityScriptedSource.answers.shift() ?? 'valid';
  }
}

/** Owns the tokens starting with 'activitytwo-'; overrides revalidate() with the two parameters a source written before ISocketRevalidation has. */
export class ActivityTwoParameterSource extends SocketPrincipalSource {
  public static calls = 0;

  public readonly name = 'activity-two-parameters';
  public readonly order = 7;

  public async authenticate(handshake: ISocketHandshake): Promise<Principal | null> {
    const token = handshake.auth.token;
    if (typeof token !== 'string' || !token.startsWith('activitytwo-')) {
      return null;
    }

    return { type: 'user', id: token, authenticated: true, source: 'token', attributes: {} };
  }

  public async revalidate(handshake: ISocketHandshake, principal: Principal): Promise<SocketRevalidationResult> {
    ActivityTwoParameterSource.calls++;
    return super.revalidate(handshake, principal);
  }
}

DI.register(ActivityScriptedSource).as(SocketPrincipalSource);
DI.register(ActivityTwoParameterSource).as(SocketPrincipalSource);

@SocketController('activity')
export class ActivitySocket extends BaseSocketController {
  public static pokes = 0;

  @Command('ping')
  public async ping() {
    return 'pong';
  }

  @OnEvent('poke')
  public async poke() {
    ActivitySocket.pokes++;
  }
}

const SWEEP: ISocketRevalidation = { trigger: 'sweep', active: false };
const ACTIVE_SWEEP: ISocketRevalidation = { trigger: 'sweep', active: true };

type FrameHandlers = { onCancel(...args: unknown[]): void; onCredit(...args: unknown[]): void };

const guard = () => DI.resolve(SocketPrincipalGuard) as SocketPrincipalGuard;
const dispatcher = () => DI.resolve(SocketDispatcher) as unknown as FrameHandlers;
const connectionOf = (socket: ClientSocket) => DI.resolve(SocketHub).connection(socket.id!)!;

describe('socket client activity in revalidation', function () {
  this.timeout(15000);

  // the default http.socket.auth.revalidateMs
  const REVALIDATE_MS = 60_000;

  let t: ITestServer;
  let sockets: ClientSocket[] = [];
  let clock: sinon.SinonFakeTimers | null = null;
  const sandbox = sinon.createSandbox();

  /** Only Date is faked and the guard's own timer is stopped: each test runs its sweeps with `sweep()`. */
  const start = async () => {
    clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    // engine.io-client drops a connection whose ping is overdue by Date.now(), which the fake clock moves too
    t = await startServer({ http: { socket: { pingInterval: 300_000 } } });
    guard().stop();
  };

  const openWith = async (token: string): Promise<ClientSocket> => {
    const socket = await open(t, { auth: { clientId: `activity-client-${sockets.length}`, token } });
    sockets.push(socket);
    return socket;
  };

  /** Makes every connection due and runs one sweep to its end. */
  const sweep = async () => {
    clock!.tick(REVALIDATE_MS);
    await guard().sweep();
  };

  beforeEach(() => {
    ActivityScriptedSource.reset();
    ActivityTwoParameterSource.calls = 0;
    ActivitySocket.pokes = 0;
  });

  afterEach(async () => {
    clock?.restore();
    clock = null;
    sandbox.restore();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('tells the source of a sweep without client traffic that the client was not active', async () => {
    await start();
    await openWith('activity-idle');

    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([SWEEP]);
  });

  it('reports a command to the next sweep only', async () => {
    await start();
    const socket = await openWith('activity-command');

    expect(resultOf(await command(socket, 'activity.ping'))).to.equal('pong');
    await sweep();
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([ACTIVE_SWEEP, SWEEP]);
  });

  it('counts a client event as activity', async () => {
    await start();
    const socket = await openWith('activity-event');

    socket.emit(WIRE_EVENTS.event, { name: 'activity.poke', payload: null });
    await waitFor(() => ActivitySocket.pokes === 1);
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([ACTIVE_SWEEP]);
  });

  it('does not count cancel or credit frames as activity', async () => {
    await start();
    const socket = await openWith('activity-frames');
    const cancels = sandbox.spy(dispatcher(), 'onCancel');
    const credits = sandbox.spy(dispatcher(), 'onCredit');

    socket.emit(WIRE_EVENTS.cancel, { id: 'activity-no-such-command' });
    socket.emit(WIRE_EVENTS.credit, { id: 'activity-no-such-stream', credits: 1 });
    await waitFor(() => cancels.calledOnce && credits.calledOnce);
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([SWEEP]);
  });

  it('counts a refused command, as a refused http request still slides the session', async () => {
    await start();
    const socket = await openWith('activity-refused');

    expect(errorOf(await command(socket, 'activity.missing')).code).to.equal('unimplemented');
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([ACTIVE_SWEEP]);
  });

  /** Starts a sweep whose source call is held; `during` runs while it is in flight, one ms after the check started. */
  const sweepHeld = async (during: () => Promise<void>) => {
    let release!: () => void;
    ActivityScriptedSource.gate = new Promise<void>((resolve) => (release = resolve));
    const checks = ActivityScriptedSource.checks.length;
    clock!.tick(REVALIDATE_MS);
    const sweeping = guard().sweep();
    await waitFor(() => ActivityScriptedSource.checks.length === checks + 1);

    clock!.tick(1);
    await during();
    // the check ends later than the activity, so a stamp taken when it ends would cover it
    clock!.tick(1);
    release();
    await sweeping;
    ActivityScriptedSource.gate = null;
  };

  it('reports activity that arrives while an active check is in flight to the following sweep', async () => {
    await start();
    const socket = await openWith('activity-in-flight');
    const ensures = sandbox.spy(guard(), 'ensure');
    expect(resultOf(await command(socket, 'activity.ping'))).to.equal('pong');

    let reply!: ReturnType<typeof command>;
    await sweepHeld(async () => {
      reply = command(socket, 'activity.ping');
      await waitFor(() => ensures.callCount === 2);
    });
    expect(resultOf(await reply)).to.equal('pong');
    await sweep();
    await sweep();

    // no 'command' check: the due command joined the held one through the pending map
    expect(ActivityScriptedSource.checks).to.deep.equal([ACTIVE_SWEEP, ACTIVE_SWEEP, SWEEP]);
  });

  it('keeps the activity of a command that joined an in-flight check started without activity', async () => {
    await start();
    const socket = await openWith('activity-joined');
    const ensures = sandbox.spy(guard(), 'ensure');

    let reply!: ReturnType<typeof command>;
    await sweepHeld(async () => {
      reply = command(socket, 'activity.ping');
      await waitFor(() => ensures.calledOnce);
    });
    expect(resultOf(await reply)).to.equal('pong');
    await sweep();
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([SWEEP, ACTIVE_SWEEP, SWEEP]);
  });

  it('keeps the activity of an event that joined an in-flight check started without activity', async () => {
    await start();
    const socket = await openWith('activity-joined-event');
    const ensures = sandbox.spy(guard(), 'ensure');

    await sweepHeld(async () => {
      socket.emit(WIRE_EVENTS.event, { name: 'activity.poke', payload: null });
      await waitFor(() => ensures.calledOnce);
    });
    await waitFor(() => ActivitySocket.pokes === 1);
    await sweep();
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([SWEEP, ACTIVE_SWEEP, SWEEP]);
  });

  it("keeps the activity for the retry after an 'unavailable' answer", async () => {
    await start();
    const socket = await openWith('activity-unavailable');
    ActivityScriptedSource.answers = ['unavailable'];

    expect(resultOf(await command(socket, 'activity.ping'))).to.equal('pong');
    await sweep();
    expect(connectionOf(socket).auth.unavailableSince).to.be.a('number');
    await sweep();
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([ACTIVE_SWEEP, ACTIVE_SWEEP, SWEEP]);
    expect(socket.connected).to.be.true;
  });

  it('tells the source of a check a command found due that the command caused it', async () => {
    await start();
    const socket = await openWith('activity-due-command');

    clock!.tick(REVALIDATE_MS);
    expect(resultOf(await command(socket, 'activity.ping'))).to.equal('pong');
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([{ trigger: 'command', active: true }, SWEEP]);
  });

  it('tells the source of a check an event found due that the event caused it', async () => {
    await start();
    const socket = await openWith('activity-due-event');

    clock!.tick(REVALIDATE_MS);
    socket.emit(WIRE_EVENTS.event, { name: 'activity.poke', payload: null });
    await waitFor(() => ActivitySocket.pokes === 1);
    await sweep();

    expect(ActivityScriptedSource.checks).to.deep.equal([{ trigger: 'event', active: true }, SWEEP]);
  });

  it('still calls a source that overrides revalidate() with two parameters', async () => {
    await start();
    const socket = await openWith('activitytwo-legacy');

    expect(resultOf(await command(socket, 'activity.ping'))).to.equal('pong');
    await sweep();

    expect(ActivityTwoParameterSource.calls).to.equal(1);
    expect(socket.connected).to.be.true;
  });

  it('restores an auth state with or without activeAt', async () => {
    await start();
    const client = { clientId: 'activity-restored', protocol: PROTOCOL_VERSION };
    const auth = { principal: { type: 'user', id: 'activity-restored', authenticated: true, source: 'token', attributes: {} }, source: 'activity', checkedAt: Date.now() };

    expect(guard().restorable({ client, auth })).to.be.true;
    expect(guard().restorable({ client, auth: { ...auth, activeAt: Date.now() } })).to.be.true;
  });

  it('tells the source of a recovered connection that the client was active, without any command', async () => {
    t = await startServer();
    const hub = DI.resolve(SocketHub);
    const first = await openWith('activity-recovered');
    const id = first.id!;

    // a packet with an offset: socket.io recovers only a session the client has read from
    const received = nextEvent(first, 'activity.hello');
    hub.connection(id)!.emit('activity.hello', {});
    await received;
    const { _pid: pid, _lastOffset: offset } = first as unknown as { _pid: string; _lastOffset: string };
    first.io.engine.close();
    await waitFor(() => hub.connection(id) === undefined);

    const second = connect(t, { auth: { clientId: 'activity-recovered-again', token: 'activity-recovered', pid, offset } });
    sockets.push(second);
    await connected(second);
    await waitFor(() => ActivityScriptedSource.checks.length === 1);

    expect(t.server.Io!.of('/').sockets.get(second.id!)!.recovered).to.be.true;
    expect(ActivityScriptedSource.checks).to.deep.equal([{ trigger: 'recovery', active: true }]);
  });
});
