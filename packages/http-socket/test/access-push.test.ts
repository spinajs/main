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
