import 'mocha';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSocketController, Command, Connection, SocketConnection, SocketController, SocketPolicy } from '@spinajs/http-socket';
import type { Socket as ClientSocket } from 'socket.io-client';

import * as socketApi from '../../src/socket/index.js';
import { Authenticated, MfaSatisfied, NoImpersonationPolicy, NoTokenAuthPolicy, NotLoggedPolicy } from '../../src/socket/index.js';
import * as v3 from '../../src/v3/index.js';
import { loggedIn, loggedInAal2, seedUser, startApp, step, stopApp, switchHooksOn, tokens, useFakes } from '../v3-app/app.js';
import { closeSockets, command, connected, disconnectNotice, errorOf, refusalOf, resultOf, socketTo, startSockets, stopSockets } from './support.js';
import type { SocketOptions } from './support.js';

@SocketController('authnsock')
export class SocketAuthnProbe extends BaseSocketController {
  @Command('who')
  public async who(@Connection() conn: SocketConnection) {
    return { type: conn.principal.type, id: conn.principal.id, source: conn.auth.source };
  }

  @Command('authenticated')
  @SocketPolicy(Authenticated)
  public async authenticated() {
    return 'ok';
  }

  @Command('notLogged')
  @SocketPolicy(NotLoggedPolicy)
  public async notLogged() {
    return 'ok';
  }

  @Command('noToken')
  @SocketPolicy(NoTokenAuthPolicy)
  public async noToken() {
    return 'ok';
  }

  @Command('noImpersonation')
  @SocketPolicy(NoImpersonationPolicy)
  public async noImpersonation() {
    return 'ok';
  }

  @Command('mfa')
  @SocketPolicy(MfaSatisfied)
  public async mfa() {
    return 'ok';
  }
}

async function bearerFor(): Promise<{ id: string; token: string }> {
  const u = await seedUser();
  const token = `spt_${randomUUID()}`;
  tokens.set(token, u.ref);
  return { id: u.ref.id, token };
}

async function opened(o: SocketOptions = {}): Promise<ClientSocket> {
  const socket = socketTo(o);
  await connected(socket);
  return socket;
}

describe('@spinajs/authn-http/socket: authn and the 3.0 authn-http policies on sockets (G5)', function () {
  this.timeout(60000);

  before(async () => {
    useFakes();
    await startApp();
    await switchHooksOn();
    await startSockets(200);
  });

  after(async () => {
    closeSockets();
    await stopSockets();
    await stopApp();
  });

  afterEach(closeSockets);

  it('exports the session source and the five 3.0 policies that work on sockets; the package root does not load it', () => {
    expect(Object.keys(socketApi).sort()).to.deep.equal(['Authenticated', 'MfaSatisfied', 'NoImpersonationPolicy', 'NoTokenAuthPolicy', 'NotLoggedPolicy', 'SessionSocketPrincipalSource']);
    expect(socketApi.NoTokenAuthPolicy).to.equal(v3.NoTokenAuthPolicy);
    expect(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.ts'), 'utf8')).to.not.match(/['"]\.\/socket(\/|\.js|['"])/);
  });

  describe('bearer tokens through the real AuthnService', () => {
    it('connects a valid API token as its identity: authn-http bearer extractor, AuthnService, token strategy', async () => {
      const { id, token } = await bearerFor();

      expect(resultOf(await command(await opened({ token }), 'authnsock.who'))).to.deep.equal({ type: 'user', id, source: 'authn' });
    });

    it('A02 refuses an unknown or revoked token with the one answer', async () => {
      expect(await refusalOf(socketTo({ token: `spt_${randomUUID()}` }))).to.deep.equal({ code: 'unauthenticated', message: 'authentication failed', retryable: false });
    });

    it('leaves a token that is not ours ( no authn.token.prefix ) unread: UNATTENDED', async () => {
      expect(resultOf(await command(await opened({ token: 'someone-elses-token' }), 'authnsock.who'))).to.deep.equal({ type: 'unattended', id: 'unattended', source: null });
    });

    it('SR-08 closes an open socket at the next revalidation once its token is revoked', async () => {
      const { token } = await bearerFor();
      const socket = await opened({ token });
      const notice = disconnectNotice(socket);

      tokens.delete(token);
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
    });
  });

  describe('the 3.0 authn-http policies as @SocketPolicy', () => {
    it('Authenticated passes a token principal and answers UNATTENDED unauthenticated', async () => {
      expect(resultOf(await command(await opened({ token: (await bearerFor()).token }), 'authnsock.authenticated'))).to.equal('ok');
      expect(errorOf(await command(await opened(), 'authnsock.authenticated'))).to.deep.include({ code: 'unauthenticated', details: { error: 'unauthenticated' } });
    });

    it('NotLoggedPolicy passes UNATTENDED and refuses an authenticated caller', async () => {
      expect(resultOf(await command(await opened(), 'authnsock.notLogged'))).to.equal('ok');
      expect(errorOf(await command(await opened({ token: (await bearerFor()).token }), 'authnsock.notLogged'))).to.deep.include({ code: 'forbidden', details: { error: 'already_authenticated' } });
    });

    it('NoTokenAuthPolicy refuses a token principal and passes a session principal', async () => {
      expect(errorOf(await command(await opened({ token: (await bearerFor()).token }), 'authnsock.noToken'))).to.deep.include({ code: 'forbidden', details: { error: 'session_required' } });
      const c = await loggedIn(await seedUser());
      expect(resultOf(await command(await opened({ cookie: c.cookie }), 'authnsock.noToken'))).to.equal('ok');
    });

    it('NoImpersonationPolicy passes a session and refuses an impersonation session', async () => {
      const own = await loggedIn(await seedUser());
      expect(resultOf(await command(await opened({ cookie: own.cookie }), 'authnsock.noImpersonation'))).to.equal('ok');

      const target = await seedUser();
      const admin = await loggedInAal2(await seedUser());
      expect((await admin.post('/auth/impersonate', { target: target.ref.id })).status).to.eq(200);
      expect(errorOf(await command(await opened({ cookie: admin.cookie }), 'authnsock.noImpersonation'))).to.deep.include({ code: 'forbidden', details: { error: 'impersonating' } });
    });

    it('NotLoggedPolicy refuses a logged-in session caller too', async () => {
      const c = await loggedIn(await seedUser());
      expect(errorOf(await command(await opened({ cookie: c.cookie }), 'authnsock.notLogged'))).to.deep.include({ code: 'forbidden', details: { error: 'already_authenticated' } });
    });

    it('MfaSatisfied refuses an aal1 session of an enrolled identity', async () => {
      const u = await seedUser();
      const c = await loggedIn(u);
      step.enrol(u.ref);
      expect(errorOf(await command(await opened({ cookie: c.cookie }), 'authnsock.mfa'))).to.deep.include({ code: 'forbidden', details: { error: 'mfa_required' } });
    });

    it('MfaSatisfied passes an aal2 session and answers UNATTENDED unauthenticated', async () => {
      const c = await loggedInAal2(await seedUser());
      expect(resultOf(await command(await opened({ cookie: c.cookie }), 'authnsock.mfa'))).to.equal('ok');
      expect(errorOf(await command(await opened(), 'authnsock.mfa'))).to.deep.include({ code: 'unauthenticated', details: { error: 'unauthenticated' } });
    });
  });
});
