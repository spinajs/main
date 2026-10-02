import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { request } from 'http';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { PROTOCOL_VERSION, SYSTEM_EVENTS } from '@spinajs/http-socket-common';
import { SocketHub } from '../src/hub.js';
import { SocketPrincipalGuard } from '../src/principal-guard.js';
import { IConnectOptions, ITestServer, connect, delay, nextEvent, open, startServer, waitFor } from './harness.js';

interface IRawReply {
  status: number;
  body: string;
}

/** A raw engine.io handshake request, the way a `<script>` tag or a server-side client would send it. */
function rawHandshake(t: ITestServer, query: string, headers: Record<string, string> = {}): Promise<IRawReply> {
  return new Promise((resolve, reject) => {
    const req = request(`${t.url}${t.path}/?EIO=4&${query}`, { headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('socket handshake: cross-site requests without an Origin', function () {
  this.timeout(15000);

  let t: ITestServer;

  beforeEach(async () => {
    t = await startServer();
  });

  afterEach(async () => {
    await t.close();
  });

  it('refuses JSONP polling, which a cross-site <script> could read with the victim cookies', async () => {
    const reply = await rawHandshake(t, 'transport=polling&j=0', { cookie: 'sid=victim' });
    expect(reply.status).to.equal(403);
    expect(reply.body).not.to.contain('___eio');
  });

  it('refuses a polling handshake marked Sec-Fetch-Site: cross-site that carries no Origin', async () => {
    expect((await rawHandshake(t, 'transport=polling', { 'sec-fetch-site': 'cross-site' })).status).to.equal(403);
  });

  it('refuses a polling handshake marked Sec-Fetch-Site: same-site that carries no Origin', async () => {
    expect((await rawHandshake(t, 'transport=polling', { 'sec-fetch-site': 'same-site' })).status).to.equal(403);
  });

  it('still accepts a non-browser client: no Origin and no Sec-Fetch-* headers', async () => {
    const reply = await rawHandshake(t, 'transport=polling');
    expect(reply.status).to.equal(200);
    expect(reply.body).to.match(/^0\{"sid":/);
  });

  it('accepts a same-origin page: no Origin and Sec-Fetch-Site: same-origin', async () => {
    expect((await rawHandshake(t, 'transport=polling', { 'sec-fetch-site': 'same-origin' })).status).to.equal(200);
  });
});

describe('socket handshake: connection state recovery', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const track = (socket: ClientSocket): ClientSocket => {
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    t = await startServer();
  });

  afterEach(async () => {
    sinon.restore();
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  /** Opens a checked connection, makes the server send it one stored packet, then drops the engine connection. */
  const dropped = async (options: IConnectOptions) => {
    const hub = DI.resolve(SocketHub);
    const first = track(await open(t, options));
    const id = first.id!;

    const received = nextEvent(first, 'recovery.ping');
    hub.connection(id)!.emit('recovery.ping', {});
    await received;

    const { _pid: pid, _lastOffset: offset } = first as unknown as { _pid: string; _lastOffset: string };
    expect(pid).to.be.a('string');
    expect(offset).to.be.a('string');

    first.io.engine.close();
    await waitFor(() => hub.connection(id) === undefined);

    return { id, pid, offset };
  };

  const disconnectedWithin = (socket: ClientSocket, ms: number): Promise<boolean> => Promise.race([new Promise<boolean>((resolve) => socket.once('disconnect', () => resolve(true))), delay(ms).then(() => false)]);

  it('keeps the clientId and protocol the handshake checked, whatever the recovering handshake claims', async () => {
    const { id, pid, offset } = await dropped({ auth: { clientId: 'c-checked' } });

    const second = track(await open(t, { auth: { pid, offset, clientId: 'c-intruder', protocol: 999 } }));
    const connection = DI.resolve(SocketHub).connection(second.id!)!;

    expect(second.id).to.equal(id);
    expect(connection.clientId).to.equal('c-checked');
    expect(connection.protocol).to.equal(PROTOCOL_VERSION);
  });

  const storedData = (pid: string): Record<string, unknown> => (t.server.Io!.of('/').adapter as unknown as { sessions: Map<string, { data: Record<string, unknown> }> }).sessions.get(pid)!.data;

  for (const [what, spoil] of [
    ['lacks socket.data.client', (data: Record<string, unknown>) => delete data.client],
    ['lacks socket.data.auth', (data: Record<string, unknown>) => delete data.auth],
    ['has a malformed socket.data.auth', (data: Record<string, unknown>) => ((data.auth as Record<string, unknown>).checkedAt = 'yesterday')],
  ] as const) {
    it(`forces a full handshake when the stored state ${what}`, async () => {
      const { id, pid, offset } = await dropped({ auth: { clientId: 'c-stale' } });
      spoil(storedData(pid));

      const second = track(await open(t, { auth: { pid, offset, clientId: 'c-fresh' } }));

      expect(second.id).not.to.equal(id);
      expect(DI.resolve(SocketHub).connection(second.id!)!.clientId).to.equal('c-fresh');
    });
  }

  for (const field of ['client', 'auth']) {
    it(`disconnects a recovered connection whose stored state lacks socket.data.${field}, should the restore check let it through (fail closed)`, async () => {
      const { id, pid, offset } = await dropped({ auth: { clientId: 'c-stale' } });
      sinon.stub(DI.resolve(SocketPrincipalGuard), 'restorable').returns(true);
      delete storedData(pid)[field];

      const second = track(connect(t, { auth: { pid, offset } }));
      const notice = nextEvent<{ reason: string }>(second, SYSTEM_EVENTS.disconnect);

      expect(await disconnectedWithin(second, 2000)).to.be.true;
      expect(await notice).to.deep.equal({ reason: 'unauthenticated' });
      expect(DI.resolve(SocketHub).connection(id)).to.be.undefined;
    });
  }

  it('disconnects a recovered connection whose new handshake comes from a foreign Origin', async () => {
    const { id, pid, offset } = await dropped({ auth: { clientId: 'c-origin' } });

    const second = track(connect(t, { auth: { pid, offset }, headers: { origin: 'https://evil.example' } }));
    const notice = nextEvent<{ reason: string }>(second, SYSTEM_EVENTS.disconnect);

    expect(await disconnectedWithin(second, 2000)).to.be.true;
    expect(await notice).to.deep.equal({ reason: 'forbidden' });
    expect(DI.resolve(SocketHub).connection(id)).to.be.undefined;
  });
});

describe('socket server: dispose', function () {
  this.timeout(15000);

  let t: ITestServer;

  afterEach(async () => {
    await t.close();
  });

  it('closes the adapter of every namespace', async () => {
    t = await startServer();
    const io = t.server.Io!;
    const main = sinon.spy(io.of('/').adapter, 'close');
    const extra = sinon.spy(io.of('/extra').adapter, 'close');

    await t.server.dispose();

    expect(main.calledOnce).to.be.true;
    expect(extra.calledOnce).to.be.true;
  });

  it('gives a shared http server back its own listeners', async () => {
    const plain = (_req: unknown, res: { end(body: string): void }) => res.end('plain');
    const counts: Record<string, number> = {};

    t = await startServer({}, (host) => {
      host.Http.on('request', plain);
      for (const event of ['upgrade', 'close', 'listening']) {
        counts[event] = host.Http.listenerCount(event);
      }
    });

    await t.server.dispose();

    expect(t.host.Http.listeners('request')).to.deep.equal([plain]);
    for (const event of ['upgrade', 'close', 'listening']) {
      expect(t.host.Http.listenerCount(event), event).to.equal(counts[event]);
    }
    expect(await rawHandshake(t, 'transport=polling')).to.deep.equal({ status: 200, body: 'plain' });
  });
});
