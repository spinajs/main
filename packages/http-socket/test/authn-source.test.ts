import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { AuthnService, CredentialExtractor } from '@spinajs/authn/contracts';
import type { AuthenticationResult, AuthenticationStrategy, AuthnContext, Credentials, SignedRequest } from '@spinajs/authn/contracts';
import { UNATTENDED } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { AuthnCredentialSource } from '../src/authn-source.js';
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

  public strategies(): readonly AuthenticationStrategy[] {
    return [];
  }
}

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
