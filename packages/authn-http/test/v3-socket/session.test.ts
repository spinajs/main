import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { createHash, randomUUID } from 'node:crypto';
import { Settings } from 'luxon';
import { DI } from '@spinajs/di';
import { SessionIssuer } from '@spinajs/authn/contracts';
import type { AuthnContext, Principal } from '@spinajs/authn/contracts';
import { storageKeyOf } from '@spinajs/authn-session';
import type { ISession, SessionProvider } from '@spinajs/authn-session';
import { AuthnCredentialSource, BaseSocketController, Command, Connection, SocketConnection, SocketController, SocketPrincipalSource } from '@spinajs/http-socket';
import type { ISocketHandshake } from '@spinajs/http-socket';

import { SessionSocketPrincipalSource } from '../../src/socket/index.js';
import { Client, clearLog, cookieName, events, guard, identities, logLines, loggedIn, loggedInAal2, roles, seedUser, signed, startApp, step, stopApp, switchHooksOn, tokens, useFakes } from '../v3-app/app.js';
import { closeSockets, command, connected, disconnectNotice, refusalOf, resultOf, socketTo, startSockets, stopSockets } from './support.js';
import type { SocketOptions } from './support.js';

@SocketController('sess')
export class SocketSessionProbe extends BaseSocketController {
  @Command('who')
  public async who(@Connection() conn: SocketConnection) {
    return { type: conn.principal.type, id: conn.principal.id, source: conn.auth.source, roles: conn.principal.ceiling?.roles ?? null };
  }
}

const UNATTENDED_WHO = { type: 'unattended', id: 'unattended', source: null, roles: null };

const REVALIDATE_MS = 200;
// V3AppConfiguration: SlidingCappedExpiration, ttl 120, maxLifetime 1440 (minutes)
const IDLE_MS = 120 * 60_000;
const MAX_LIFETIME_MS = 1440 * 60_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Only the session layer's clock ( luxon ) moves: a faked Date makes engine.io-client close its socket as ping-expired.
const realSessionClock = Settings.now;
const sessionClockAt = (ms: number): void => {
  Settings.now = () => ms;
};

// AuthnMiddleware's log hash: socket and http log lines of one session correlate
const logHash = (value: string): string => createHash('sha256').update(`authn-http:log\0${value}`).digest('hex').slice(0, 16);

async function who(o: SocketOptions) {
  const socket = socketTo(o);
  await connected(socket);
  return { socket, who: resultOf(await command(socket, 'sess.who')) };
}

async function bearerFor(): Promise<{ id: string; token: string }> {
  const u = await seedUser();
  const token = `spt_${randomUUID()}`;
  tokens.set(token, u.ref);
  return { id: u.ref.id, token };
}

function handshakeOf(cookie: string): ISocketHandshake {
  // a variable, not a returned literal: an http-socket lib built before peerAddress was added would reject it as excess
  const handshake = { auth: {}, headers: {}, cookies: { [cookieName()]: cookie }, address: '127.0.0.1', peerAddress: '127.0.0.1', url: '/socket.io/?EIO=4&transport=websocket', query: {}, secure: false, issuedAt: Date.now() };
  return handshake;
}

async function sessionSource(): Promise<SessionSocketPrincipalSource> {
  const sources = (await DI.resolve(Array.ofType(SocketPrincipalSource))) as SocketPrincipalSource[];
  const source = sources.find((s) => s instanceof SessionSocketPrincipalSource);
  if (!source) throw new Error('SessionSocketPrincipalSource is not registered');
  return source as SessionSocketPrincipalSource;
}

async function sessionStore(): Promise<SessionProvider> {
  return ((await DI.resolve(SessionIssuer)) as unknown as { Store: SessionProvider }).Store;
}

type RevalidateSpy = sinon.SinonSpy<Parameters<SessionSocketPrincipalSource['revalidate']>, ReturnType<SessionSocketPrincipalSource['revalidate']>>;

/** The first revalidate() from call `from` on whose check reports client activity; null when the guard passes no check at all. */
async function activeRevalidation(spy: RevalidateSpy, from: number, timeoutMs = 5000): Promise<sinon.SinonSpyCall<Parameters<SessionSocketPrincipalSource['revalidate']>, ReturnType<SessionSocketPrincipalSource['revalidate']>> | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const calls = spy.getCalls().slice(from);
    if (calls.some((call) => call.args[2] === undefined)) {
      return null;
    }

    const active = calls.find((call) => call.args[2]?.active === true);
    if (active) {
      return active;
    }

    if (Date.now() > until) {
      throw new Error(`no revalidation reporting client activity within ${timeoutMs} ms`);
    }
    await delay(20);
  }
}

/** The live row of the memory store; restore() of the store itself does not slide it. */
async function storedRow(c: Client): Promise<ISession> {
  const row = await (await sessionStore()).restore(storageKeyOf(c.sessionId!));
  if (!row) throw new Error('the session is not in the store');
  return row;
}

describe('@spinajs/authn-http/socket: session cookie source (G6)', function () {
  this.timeout(60000);

  before(async () => {
    useFakes();
    await startApp();
    await switchHooksOn();
    await startSockets(REVALIDATE_MS);
  });

  after(async () => {
    closeSockets();
    await stopSockets();
    await stopApp();
  });

  afterEach(() => {
    closeSockets();
    sinon.restore();
    Settings.now = realSessionClock;
  });

  it('connects an active session cookie as its user', async () => {
    const u = await seedUser();
    const c = await loggedIn(u);

    expect((await who({ cookie: c.cookie })).who).to.deep.equal({ type: 'user', id: u.ref.id, source: 'session', roles: null });
  });

  it('runs before the bearer source: an active session wins over a bearer token, as in http', async () => {
    expect(new SessionSocketPrincipalSource().order).to.be.below(new AuthnCredentialSource().order);
    const u = await seedUser();
    const c = await loggedIn(u);
    const { token } = await bearerFor();

    expect((await who({ cookie: c.cookie, token })).who).to.deep.include({ id: u.ref.id, source: 'session' });
  });

  it('SR-07 gives no principal for a pending session, and a bearer token is still tried', async () => {
    const u = await seedUser();
    step.enrol(u.ref);
    const c = new Client();
    expect((await c.post('/auth/login', { login: u.login, password: u.password })).status).to.eq(200);
    const other = await bearerFor();

    expect((await who({ cookie: c.cookie })).who).to.deep.equal(UNATTENDED_WHO);
    expect((await who({ cookie: c.cookie, token: other.token })).who).to.deep.include({ id: other.id, source: 'authn' });
  });

  it('sets ceiling.roles to the ActiveRole of a role switch', async () => {
    const u = await seedUser();
    await roles.grant(u.ref, [{ role: 'editor', requirePassword: false }]);
    const c = await loggedIn(u);
    expect((await c.post('/auth/active-role', { role: 'editor' })).status).to.eq(200);

    expect((await who({ cookie: c.cookie })).who).to.deep.equal({ type: 'user', id: u.ref.id, source: 'session', roles: ['editor'] });
  });

  it('ignores a forged cookie without asking the session store', async () => {
    const restore = sinon.spy((await DI.resolve(SessionIssuer)) as SessionIssuer, 'restore');

    expect((await who({ cookie: 'raw-session-id.forged-signature' })).who).to.deep.equal(UNATTENDED_WHO);
    expect(restore.calledWith('raw-session-id')).to.eq(false);
  });

  it('SR-12 refuses a cross-origin handshake carrying the session cookie before the source runs', async () => {
    const c = await loggedIn(await seedUser());
    const restore = sinon.spy((await DI.resolve(SessionIssuer)) as SessionIssuer, 'restore');

    expect(await refusalOf(socketTo({ cookie: c.cookie, origin: 'https://evil.example' }))).to.deep.include({ code: 'forbidden', message: 'origin not allowed' });
    expect(restore.calledWith(c.sessionId!)).to.eq(false);
  });

  it('SR-08 closes the socket of a session that logout ended, at the next revalidation', async () => {
    const c = await loggedIn(await seedUser());
    const { socket } = await who({ cookie: c.cookie });
    const notice = disconnectNotice(socket);

    expect((await c.post('/auth/logout')).status).to.eq(200);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
  });

  it('closes a socket whose session id a role switch rotated; the new cookie connects', async () => {
    const u = await seedUser();
    await roles.grant(u.ref, [{ role: 'editor', requirePassword: false }]);
    const c = await loggedIn(u);
    const { socket } = await who({ cookie: c.cookie });
    const notice = disconnectNotice(socket);

    expect((await c.post('/auth/active-role', { role: 'editor' })).status).to.eq(200);
    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    expect((await who({ cookie: c.cookie })).who).to.deep.include({ id: u.ref.id, roles: ['editor'] });
  });

  it('M2 refuses an active session that gives no principal, without trying a bearer token, as http does', async () => {
    const u = await seedUser();
    const c = await loggedIn(u);
    const other = await bearerFor();
    identities.setStatus(u.ref, { banned: true });

    expect(await refusalOf(socketTo({ cookie: c.cookie, token: other.token }))).to.deep.include({ code: 'unauthenticated' });
  });

  it('M4 ends an impersonation past maxMinutes and closes its socket', async () => {
    await guard.allowAll();
    const target = await seedUser();
    const c = await loggedInAal2(await seedUser());
    expect((await c.post('/auth/impersonate', { target: target.ref.id })).status).to.eq(200);
    const { socket, who: seen } = await who({ cookie: c.cookie });
    expect(seen).to.deep.include({ id: target.ref.id, source: 'session' });
    const notice = disconnectNotice(socket);

    type WithContext = { context(handshake: ISocketHandshake): AuthnContext };
    const proto = SessionSocketPrincipalSource.prototype as unknown as WithContext;
    const context = proto.context;
    // V3AppConfiguration: impersonation.maxMinutes 60
    sinon.stub(proto, 'context').callsFake(function (this: WithContext, handshake: ISocketHandshake) {
      return { ...context.call(this, handshake), now: new Date(Date.now() + 61 * 60_000) };
    });

    expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    expect(events.ofType('impersonation.expire').some((e) => e.reason === 'max_minutes')).to.eq(true);
    expect(await (await sessionStore()).restore(storageKeyOf(c.sessionId!))).to.eq(null);
  });

  describe('cookie rules shared with AuthnMiddleware', () => {
    it("accepts the `s:` form of express's signed cookies and refuses it with a wrong signature", async () => {
      const u = await seedUser();
      const c = await loggedIn(u);

      expect((await who({ cookie: `s:${c.cookie}` })).who).to.deep.include({ id: u.ref.id, source: 'session' });
      expect((await who({ cookie: `s:${c.sessionId}.forged-signature` })).who).to.deep.equal(UNATTENDED_WHO);
    });

    it('refuses a correctly signed id of no live session, as http does', async () => {
      expect((await who({ cookie: signed(randomUUID()) })).who).to.deep.equal(UNATTENDED_WHO);
    });

    it('connects nobody once the session passed its idle timeout', async () => {
      const c = await loggedIn(await seedUser());
      sessionClockAt(Date.now() + IDLE_MS + 60_000);

      expect(await (await sessionSource()).authenticate(handshakeOf(c.cookie!))).to.eq(null);
    });

    it('refuses the handshake while the session store is down, never connecting as unattended', async () => {
      const c = await loggedIn(await seedUser());
      sinon.stub(await sessionStore(), 'restore').rejects(new Error('session store down'));

      expect((await refusalOf(socketTo({ cookie: c.cookie }))).code).to.eq('internal');
    });

    it('logs neither the session id, its storage key nor a cookie value', async () => {
      const c = await loggedIn(await seedUser());
      const rawId = c.sessionId!;
      clearLog();
      const { socket } = await who({ cookie: c.cookie });
      await who({ cookie: `${rawId}.forged-signature` });
      const notice = disconnectNotice(socket);
      await c.post('/auth/logout');
      await notice;

      const lines = logLines().join('\n');
      expect(lines).to.include('invalid signature');
      for (const secret of [rawId, storageKeyOf(rawId), signed(rawId), encodeURIComponent(signed(rawId))]) {
        expect(lines).to.not.include(secret);
      }
    });

    it('M3 takes a correctly signed empty id for no session, not for a bad signature', async () => {
      clearLog();

      expect((await who({ cookie: signed('') })).who).to.deep.equal(UNATTENDED_WHO);
      expect(logLines().join('\n')).to.not.include('invalid signature');
    });

    it('M3 logs a cookie of no live session with the hashed id, as http does', async () => {
      const c = await loggedIn(await seedUser());
      const rawId = c.sessionId!;
      expect((await c.post('/auth/logout')).status).to.eq(200);
      clearLog();

      expect((await who({ cookie: signed(rawId) })).who).to.deep.equal(UNATTENDED_WHO);
      const line = logLines().find((l) => l.includes('names no live session'));
      expect(line).to.include(logHash(rawId));
      expect(line).to.not.include(rawId);
    });
  });

  describe('revalidation ( the W1 principal guard, tri-state )', () => {
    async function connectedSession() {
      const u = await seedUser();
      const c = await loggedIn(u);
      const source = await sessionSource();
      const handshake = handshakeOf(c.cookie!);
      const principal = (await source.authenticate(handshake)) as Principal;
      expect(principal).to.include({ type: 'user', id: u.ref.id });
      return { u, c, source, handshake, principal };
    }

    it("answers 'valid' with the session's current principal for an active session", async () => {
      const { u, source, handshake, principal } = await connectedSession();

      const verdict = (await source.revalidate(handshake, principal)) as { status: string; principal: Principal };
      expect(verdict.status).to.eq('valid');
      expect(verdict.principal).to.include({ type: 'user', id: u.ref.id });
    });

    it("answers 'invalid' for a revoked session", async () => {
      const { c, source, handshake, principal } = await connectedSession();
      await ((await DI.resolve(SessionIssuer)) as SessionIssuer).revoke({ id: c.sessionId!, state: 'active' });

      expect(await source.revalidate(handshake, principal)).to.eq('invalid');
    });

    it("answers 'invalid' for a session past its idle timeout", async () => {
      const { source, handshake, principal } = await connectedSession();
      sessionClockAt(Date.now() + IDLE_MS + 60_000);

      expect(await source.revalidate(handshake, principal)).to.eq('invalid');
    });

    it("answers 'unavailable', not 'invalid', while the session store is down", async () => {
      const { source, handshake, principal } = await connectedSession();
      sinon.stub(await sessionStore(), 'restore').rejects(new Error('session store down'));

      expect(await source.revalidate(handshake, principal)).to.eq('unavailable');
    });

    it("answers 'invalid' when the session now belongs to another identity", async () => {
      const { c, source, handshake, principal } = await connectedSession();
      const other = await seedUser();
      (await storedRow(c)).Subject = other.ref;

      expect(await source.revalidate(handshake, principal)).to.eq('invalid');
    });

    it('slides the session on a check that reports client activity, as an http request does', async () => {
      const { c, source, handshake, principal } = await connectedSession();
      const row = await storedRow(c);
      const created = row.Creation.toMillis();
      sessionClockAt(created + 100 * 60_000);

      expect(await source.revalidate(handshake, principal, { trigger: 'sweep', active: true })).to.deep.include({ status: 'valid' });
      expect(row.Expiration!.toMillis()).to.eq(created + 100 * 60_000 + IDLE_MS);
    });

    it('reads the session without sliding it on a check without client activity', async () => {
      const { c, source, handshake, principal } = await connectedSession();
      const row = await storedRow(c);
      const deadline = row.Expiration!.toMillis();
      sessionClockAt(row.Creation.toMillis() + 100 * 60_000);

      expect(await source.revalidate(handshake, principal, { trigger: 'sweep', active: false })).to.deep.include({ status: 'valid' });
      expect(await source.revalidate(handshake, principal)).to.deep.include({ status: 'valid' });
      expect(row.Expiration!.toMillis()).to.eq(deadline);
    });

    it('closes the socket of a session revoked from another device', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const other = await loggedIn(u);
      const { socket } = await who({ cookie: c.cookie });
      const notice = disconnectNotice(socket);

      expect((await other.del('/user/sessions')).body).to.deep.equal({ Revoked: 1 });
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });

    it('SR-06 closes the socket of a banned user and ends the session', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const { socket } = await who({ cookie: c.cookie });
      const notice = disconnectNotice(socket);

      identities.setStatus(u.ref, { banned: true });
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
      expect(await (await sessionStore()).restore(storageKeyOf(c.sessionId!))).to.eq(null);
    });

    it('closes the socket once the session passed its idle timeout', async () => {
      const c = await loggedIn(await seedUser());
      const { socket } = await who({ cookie: c.cookie });
      const notice = disconnectNotice(socket);
      sessionClockAt(Date.now() + IDLE_MS + 60_000);

      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });

    it('refuses a session swapped to another identity', async () => {
      const c = await loggedIn(await seedUser());
      const other = await seedUser();
      const { socket } = await who({ cookie: c.cookie });
      const notice = disconnectNotice(socket);

      (await storedRow(c)).Subject = other.ref;
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });

    it('keeps serving a socket through a store outage shorter than the grace window', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const { socket } = await who({ cookie: c.cookie });
      clearLog();
      const restore = sinon.stub(await sessionStore(), 'restore');
      restore.callThrough();
      restore.onFirstCall().rejects(new Error('session store down'));

      await delay(REVALIDATE_MS + 50);
      expect(resultOf(await command(socket, 'sess.who'))).to.deep.include({ id: u.ref.id, source: 'session' });
      expect(logLines().some((l) => l.includes('could not revalidate its principal'))).to.eq(true);

      await delay(REVALIDATE_MS * 3);
      expect(socket.connected).to.eq(true);
      expect(resultOf(await command(socket, 'sess.who'))).to.deep.include({ id: u.ref.id, source: 'session' });
      expect(restore.callCount).to.be.above(1);
    });

    it('closes the socket when the store is still down after the grace window', async () => {
      const c = await loggedIn(await seedUser());
      const { socket } = await who({ cookie: c.cookie });
      clearLog();
      const notice = disconnectNotice(socket);
      sinon.stub(await sessionStore(), 'restore').rejects(new Error('session store down'));

      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
      expect(logLines().some((l) => l.includes('could not revalidate its principal'))).to.eq(true);
      expect(logLines().some((l) => l.includes('still unavailable, closing after grace'))).to.eq(true);
    });

    it('I1 never slides the session: an idle socket ends at the idle timeout despite the sweeps', async () => {
      const c = await loggedIn(await seedUser());
      // no command: a command is client activity, for which the next sweep slides the session
      const socket = socketTo({ cookie: c.cookie });
      await connected(socket);
      const row = await storedRow(c);
      const deadline = row.Expiration!.toMillis();

      sessionClockAt(row.Creation.toMillis() + 100 * 60_000);
      await delay(REVALIDATE_MS * 3);
      expect(socket.connected, 'still inside the idle timeout').to.eq(true);
      expect(row.Expiration!.toMillis(), 'the sweeps did not slide it').to.eq(deadline);

      const notice = disconnectNotice(socket);
      sessionClockAt(deadline + 1000);
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });

    it('a handshake slides the session as an http request does, and maxLifetime still ends it', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      const row = await storedRow(c);
      const created = row.Creation.toMillis();
      expect(row.Expiration!.toMillis()).to.be.closeTo(created + IDLE_MS, 5000);

      // each handshake lies inside the idle timeout the previous one renewed; together they outlive it many times
      let socket: ReturnType<typeof socketTo> | null = null;
      for (let at = 100 * 60_000; at < MAX_LIFETIME_MS; at += 100 * 60_000) {
        sessionClockAt(created + at);
        const opened = await who({ cookie: c.cookie });
        expect(opened.who, `at ${at / 60_000} min`).to.deep.include({ id: u.ref.id, source: 'session' });
        expect(row.Expiration!.toMillis(), `at ${at / 60_000} min`).to.eq(Math.min(created + at + IDLE_MS, created + MAX_LIFETIME_MS));
        socket = opened.socket;
      }

      const notice = disconnectNotice(socket!);
      sessionClockAt(created + MAX_LIFETIME_MS + 60_000);
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });

    it('slides the session of a socket-only user who sends a command in each idle window, without an http request', async function () {
      const u = await seedUser();
      const c = await loggedIn(u);
      const { socket } = await who({ cookie: c.cookie });
      const row = await storedRow(c);
      const created = row.Creation.toMillis();
      const revalidate = sinon.spy(SessionSocketPrincipalSource.prototype, 'revalidate');

      // each command lies inside the idle timeout the previous slide renewed; together they outlive the first one
      for (let at = 100 * 60_000; at <= 300 * 60_000; at += 100 * 60_000) {
        sessionClockAt(created + at);
        const from = revalidate.callCount;
        expect(resultOf(await command(socket, 'sess.who')), `at ${at / 60_000} min`).to.deep.include({ id: u.ref.id, source: 'session' });

        const check = await activeRevalidation(revalidate, from);
        if (check === null) {
          // the http-socket lib this suite resolves predates ISocketRevalidation: its guard passes no check
          this.skip();
        }
        await check.returnValue;
        expect(row.Expiration!.toMillis(), `at ${at / 60_000} min`).to.eq(created + at + IDLE_MS);
      }

      await delay(REVALIDATE_MS * 3);
      expect(socket.connected, 'past the first idle timeout').to.eq(true);
    });
  });
});
