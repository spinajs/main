import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthnService, CredentialExtractor } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthenticationStrategy, AuthnContext, Credentials, SignedRequest } from '@spinajs/authn/contracts';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import { AuthnCredentialSource, credentialRequest } from '../src/authn-source.js';
import { SocketHub } from '../src/hub.js';
import { ISocketHandshake, SocketPrincipalSource } from '../src/interfaces.js';
import { IConnectOptions, ITestServer, connect, open, refusalOf, startServer } from './harness.js';

const BOB: Principal = Object.freeze({ type: 'user', id: 'bob', authenticated: true, source: 'token', attributes: Object.freeze({}), identity: { name: 'bob' } });

const FAILED = { code: 'unauthenticated', message: 'authentication failed', retryable: false };

export class AuthnTestExtractor extends CredentialExtractor {
  public static seen: SignedRequest[] = [];

  public readonly order = 10;

  public extract(req: SignedRequest): Credentials | null {
    AuthnTestExtractor.seen.push(req);
    const value = req.headers.authorization;
    return value?.startsWith('Bearer authn-') ? { kind: 'bearer', token: value.slice('Bearer '.length) } : null;
  }
}

export class AuthnTestService extends AuthnService {
  public static contexts: AuthnContext[] = [];

  public async authenticate(credentials: Credentials, ctx: AuthnContext): Promise<AuthenticationResult> {
    AuthnTestService.contexts.push(ctx);

    switch ((credentials as { token: string }).token) {
      case 'authn-ok':
        return { status: 'success', identity: { type: 'user', id: 'bob' }, facts: { method: 'token', strategy: 'token', assurance: 'aal1', mfa: [] } };
      case 'authn-mfa':
        return { status: 'mfa_required', pending: { id: 'pending-1', state: 'pending' }, steps: ['totp'] };
      case 'authn-throttled':
        return { status: 'failure', reason: 'throttled', retryAfterSeconds: 3 };
      case 'authn-revoked':
        return { status: 'failure', reason: 'revoked' };
      case 'authn-down':
        throw new Error('authn store unreachable');
      default:
        return { status: 'failure', reason: 'invalid_credentials' };
    }
  }

  public async principalOf(): Promise<Principal> {
    return BOB;
  }

  public async completeMfa(): Promise<AuthenticationResult> {
    throw new Error('not used by socket handshakes');
  }

  public async reauthenticate(): Promise<boolean> {
    throw new Error('not used by socket handshakes');
  }

  public async stepUp(): Promise<AuthenticationResult> {
    throw new Error('not used by socket handshakes');
  }

  public strategies(): readonly AuthenticationStrategy[] {
    return [];
  }
}

describe('credentialRequest', () => {
  const handshake = (headers: ISocketHandshake['headers'], rawHeaders?: string[]): ISocketHandshake => ({ auth: {}, headers, rawHeaders, cookies: {}, address: '127.0.0.1', peerAddress: '127.0.0.1', url: '/socket.io/', query: {}, secure: false, issuedAt: 0 });
  const twice = ['Authorization', 'Bearer a', 'authorization', 'Bearer b'];

  const refusedFor = (h: ISocketHandshake, names?: readonly string[]): unknown => {
    try {
      credentialRequest(h, names);
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it('refuses Authorization or Proxy-Authorization sent more than once, in any case, as invalid_argument', () => {
    for (const raw of [twice, ['Proxy-Authorization', 'Basic a', 'PROXY-AUTHORIZATION', 'Basic b']]) {
      const err = refusedFor(handshake({ authorization: 'Bearer a' }, raw));
      expect(err, raw[0]).to.be.instanceOf(SocketException);
      expect((err as SocketException).toWire()).to.deep.equal({ code: 'invalid_argument', message: `the ${raw[0].toLowerCase()} header was sent more than once`, retryable: false });
    }
  });

  it('refuses a repeat of the other singleton names it is given, such as the API key header', () => {
    const raw = ['X-Api-Key', 'spt_a', 'x-api-key', 'spt_b'];
    expect(refusedFor(handshake({ 'x-api-key': 'spt_a, spt_b' }, raw), ['authorization', 'x-api-key'])).to.be.instanceOf(SocketException);
    expect(refusedFor(handshake({ 'x-api-key': 'spt_a, spt_b' }, raw)), 'not a singleton by default').to.equal(undefined);
  });

  it('joins any other repeated header, as Node and authn-http do: a signature and its covered fields still verify', () => {
    const raw = ['Signature', 'sig1=:a:', 'signature', 'sig2=:b:', 'Accept', 'text/html', 'accept', 'application/json', 'authorization', 'Bearer a'];
    const request = credentialRequest(handshake({ signature: 'sig1=:a:', accept: 'text/html, application/json', authorization: 'Bearer a' }, raw));
    expect(request.headers).to.include({ signature: 'sig1=:a:, sig2=:b:', accept: 'text/html, application/json', authorization: 'Bearer a' });
  });

  it('without rawHeaders (a custom handshake builder) fails closed: a singleton that is not a single string is a repeat', () => {
    for (const headers of [{ authorization: ['Bearer a', 'Bearer b'] }, { authorization: ['Bearer a'] }, { 'Proxy-Authorization': ['Basic a', 'Basic b'] }, { Authorization: 'Bearer a', authorization: 'Bearer b' }]) {
      const err = refusedFor(handshake(headers as unknown as ISocketHandshake['headers']));
      expect(err, JSON.stringify(headers)).to.be.instanceOf(SocketException);
      expect((err as SocketException).toWire().code).to.equal('invalid_argument');
    }
    expect(refusedFor(handshake({ 'x-api-key': ['spt_a', 'spt_b'] }), ['authorization', 'x-api-key'])).to.be.instanceOf(SocketException);
    expect(refusedFor(handshake({ authorization: 'Bearer a', accept: ['text/html', 'application/json'] } as unknown as ISocketHandshake['headers'])), 'only singletons count').to.equal(undefined);
    expect(credentialRequest(handshake({ authorization: 'Bearer a' })).headers.authorization).to.equal('Bearer a');
  });

  it('keeps a value a subclass put in place of the received one, and works without rawHeaders', () => {
    const raw = ['User-Agent', 'a', 'user-agent', 'b'];
    expect(credentialRequest(handshake({ 'user-agent': 'mapped' }, raw)).headers['user-agent']).to.equal('mapped');
    expect(credentialRequest(handshake({ 'user-agent': 'a' }, raw)).headers['user-agent']).to.equal('a, b');
    expect(credentialRequest(handshake({ authorization: 'Bearer a' })).headers.authorization).to.equal('Bearer a');
  });
});

describe('AuthnCredentialSource', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  const principalOf = async (options: IConnectOptions): Promise<Principal> => {
    const socket = track(await open(t, options));
    return DI.resolve(SocketHub).connection(socket.id!)!.principal;
  };

  const refusal = (options: IConnectOptions) => refusalOf(track(connect(t, options)));

  afterEach(async () => {
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  describe('with an AuthnService', () => {
    before(() => {
      DI.register(AuthnTestService).as(AuthnService);
      DI.register(AuthnTestExtractor).as(CredentialExtractor);
    });

    after(() => {
      DI.unregister(AuthnTestService);
      DI.unregister(AuthnTestExtractor);
    });

    beforeEach(async () => {
      t = await startServer();
    });

    it('resolves a token sent in auth.token through AuthnService.authenticate and principalOf', async () => {
      expect(await principalOf({ auth: { token: 'authn-ok' } })).to.equal(BOB);
      expect(AuthnTestService.contexts[AuthnTestService.contexts.length - 1].purpose).to.equal('request');
    });

    it('reads the Authorization header too', async () => {
      expect(await principalOf({ headers: { authorization: 'Bearer authn-ok' } })).to.equal(BOB);
    });

    it('refuses a repeated Authorization header before any extractor or AuthnService runs, as authn-http does', async () => {
      AuthnTestExtractor.seen = [];
      AuthnTestService.contexts = [];
      const twice = { authorization: ['Bearer authn-ok', 'Bearer authn-ok'] } as unknown as Record<string, string>;

      expect(await refusal({ headers: twice })).to.deep.equal({ code: 'invalid_argument', message: 'the authorization header was sent more than once', retryable: false });
      expect(AuthnTestExtractor.seen).to.deep.equal([]);
      expect(AuthnTestService.contexts).to.deep.equal([]);
    });

    it('refuses a repeated authn.token.headerName header', async () => {
      const twice = { 'x-api-key': ['spt_a', 'spt_b'] } as unknown as Record<string, string>;

      expect(await refusal({ headers: twice })).to.deep.include({ code: 'invalid_argument', message: 'the x-api-key header was sent more than once' });
    });

    it('A02 refuses every failure with one answer', async () => {
      expect(await refusal({ auth: { token: 'authn-wrong' } })).to.deep.equal(FAILED);
      expect(await refusal({ auth: { token: 'authn-revoked' } })).to.deep.equal(FAILED);
    });

    it('A06 a throttled handshake carries retryAfterMs', async () => {
      expect(await refusal({ auth: { token: 'authn-throttled' } })).to.deep.equal({ ...FAILED, retryAfterMs: 3000 });
    });

    it('SR-07 a login still pending MFA yields no principal', async () => {
      expect(await refusal({ auth: { token: 'authn-mfa' } })).to.deep.equal(FAILED);
    });

    it('SR-03 without a trusted proxy the client address is the socket address, never X-Forwarded-For', async () => {
      await principalOf({ auth: { token: 'authn-ok' }, headers: { 'x-forwarded-for': '6.6.6.6' } });
      const ctx = AuthnTestService.contexts[AuthnTestService.contexts.length - 1];

      expect(ctx.ip).to.match(/127\.0\.0\.1$/);
    });

    it('SR-12 cookies never reach the credential extractors', async () => {
      await principalOf({ auth: { token: 'authn-ok' }, headers: { cookie: 'ssid=stolen' } });
      const request = AuthnTestExtractor.seen[AuthnTestExtractor.seen.length - 1];

      expect(request.headers).not.to.have.property('cookie');
      expect(request.headers.authorization).to.equal('Bearer authn-ok');
    });

    it('leaves a handshake without credentials UNATTENDED', async () => {
      expect(await principalOf({})).to.equal(UNATTENDED);
    });

    describe('revalidate', () => {
      const source = new AuthnCredentialSource();
      const registered = async () => ((await DI.resolve(Array.ofType(SocketPrincipalSource))) as SocketPrincipalSource[]).find((s) => s.name === 'authn')!;
      const handshakeWith = (token?: string): ISocketHandshake => ({ auth: token ? { token } : {}, headers: {}, cookies: {}, address: '127.0.0.1', peerAddress: '127.0.0.1', url: '/socket.io/', query: {}, secure: false, issuedAt: 0 });

      it('answers valid with the principal AuthnService resolves now', async () => {
        expect(await source.revalidate(handshakeWith('authn-ok'), BOB)).to.deep.equal({ status: 'valid', principal: BOB });
      });

      it('answers invalid when AuthnService rejects or revoked the credential', async () => {
        expect(await source.revalidate(handshakeWith('authn-revoked'), BOB)).to.equal('invalid');
        expect(await source.revalidate(handshakeWith('authn-wrong'), BOB)).to.equal('invalid');
        expect(await source.revalidate(handshakeWith('authn-mfa'), BOB)).to.equal('invalid');
      });

      it('answers invalid when the handshake carries no credential any more, or another principal', async () => {
        expect(await source.revalidate(handshakeWith(), BOB)).to.equal('invalid');
        expect(await source.revalidate(handshakeWith('authn-ok'), { ...BOB, id: 'mallory' })).to.equal('invalid');
      });

      it('answers invalid for a handshake whose credential header was sent twice', async () => {
        const repeated: ISocketHandshake = { ...handshakeWith(), headers: { authorization: 'Bearer authn-ok' }, rawHeaders: ['authorization', 'Bearer authn-ok', 'authorization', 'Bearer authn-ok'] };
        expect(await source.revalidate(repeated, BOB)).to.equal('invalid');
      });

      it('answers unavailable when AuthnService fails or throttles', async () => {
        expect(await source.revalidate(handshakeWith('authn-down'), BOB)).to.equal('unavailable');
        expect(await source.revalidate(handshakeWith('authn-throttled'), BOB)).to.equal('unavailable');
      });

      it('logs the error when AuthnService throws', async () => {
        const logged = await registered();
        const warn = sinon.stub((logged as unknown as { Log: { warn: (...a: unknown[]) => void } }).Log, 'warn');
        try {
          expect(await logged.revalidate(handshakeWith('authn-down'), BOB)).to.equal('unavailable');
          expect(warn.calledOnce).to.be.true;
          expect(warn.firstCall.args.some((a) => a instanceof Error)).to.be.true;
        } finally {
          warn.restore();
        }
      });
    });
  });

  describe('without an AuthnService', () => {
    beforeEach(async () => {
      t = await startServer();
    });

    it('is inert: the token stays unread and the connection runs as UNATTENDED', async () => {
      expect(await principalOf({ auth: { token: 'authn-ok' } })).to.equal(UNATTENDED);
    });
  });
});
