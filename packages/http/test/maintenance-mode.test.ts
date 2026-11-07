import 'mocha';
import { expect } from 'chai';
import chai from 'chai';
import chaiHttp from 'chai-http';
import net from 'node:net';
import { Container, DI } from '@spinajs/di';
import { Intl } from '@spinajs/intl';
import type { TestApp } from '@spinajs/testing';
import { configurationViolations, createTestApp, disposeTestApps, readingFrom } from '@spinajs/testing';

import { appPort, httpApp } from './common.js';
import { BaseController, BasePath, Controllers, Get, HttpServer, LifecycleState, MaintenanceMode, Ok } from '../src/index.js';
import { HTTP_CONFIGURATION_SCHEMA } from '../src/schemas/http.configuration.js';
import { serverApp } from './support/server-app.js';

chai.use(chaiHttp);

/** A MaintenanceMode reading `http.maintenance` (absent when undefined) from a Configuration the http schema checked. */
async function middleware(maintenance: unknown) {
  const { container } = await createTestApp({ scope: 'child', bootstrap: false, schemas: [HTTP_CONFIGURATION_SCHEMA], config: maintenance === undefined ? {} : { http: { maintenance } } });
  const mw = readingFrom(new MaintenanceMode(), container);
  const bus = new Container();
  Object.defineProperty(mw, 'Container', { value: bus });
  await mw.resolve();
  return { mw, bus };
}

const header = (res: { header: unknown }, name: string) => (res.header as Record<string, string | undefined>)[name];
const errorOf = (res: { body: unknown }) => (res.body as { error: { code: string; message: string } }).error;

const app = (mw: MaintenanceMode) =>
  serverApp(mw, (_req, res) => {
    res.json({ ok: true });
  });

describe('MaintenanceMode', () => {
  afterEach(disposeTestApps);

  it('passes requests through when http.maintenance is absent', async () => {
    const { mw } = await middleware(undefined);
    const res = await chai.request(app(mw)).get('/probe');
    expect(res.status).to.eq(200);
    expect(mw.Active).to.eq(false);
  });

  it('answers 503 with Retry-After and the maintenance body when enabled', async () => {
    const { mw } = await middleware({ enabled: true });
    const res = await chai.request(app(mw)).get('/probe');

    expect(res.status).to.eq(503);
    expect(header(res, 'retry-after')).to.eq('60');
    expect(res.body).to.deep.eq({ error: { code: 'maintenance', message: 'The service is down for maintenance, try again later' } });
  });

  it('takes retryAfter and message from the configuration', async () => {
    const { mw } = await middleware({ enabled: true, retryAfter: 300, message: 'Back at noon' });
    const res = await chai.request(app(mw)).get('/probe');

    expect(header(res, 'retry-after')).to.eq('300');
    expect(errorOf(res)).to.deep.eq({ code: 'maintenance', message: 'Back at noon' });
  });

  it('lets allowed path prefixes through, on a segment boundary and case-insensitively', async () => {
    const { mw } = await middleware({ enabled: true, allow: ['/health', '/admin/'] });
    const status = async (path: string) => (await chai.request(app(mw)).get(path)).status;

    expect(await status('/health')).to.eq(200);
    expect(await status('/health/live')).to.eq(200);
    expect(await status('/HEALTH/live')).to.eq(200);
    expect(await status('/admin/maintenance')).to.eq(200);
    expect(await status('/healthy')).to.eq(503);
    expect(await status('/api/health')).to.eq(503);
  });

  it('enable() and disable() switch maintenance at runtime, over the configuration', async () => {
    const { mw } = await middleware({ enabled: false });

    mw.enable();
    expect(mw.Active).to.eq(true);
    expect((await chai.request(app(mw)).get('/probe')).status).to.eq(503);

    mw.disable();
    expect(mw.Active).to.eq(false);
    expect((await chai.request(app(mw)).get('/probe')).status).to.eq(200);
  });

  it('disable() wins over an enabled configuration', async () => {
    const { mw } = await middleware({ enabled: true });
    mw.disable();
    expect((await chai.request(app(mw)).get('/probe')).status).to.eq(200);
  });

  it('answers every request 503 with Connection: close while the HttpServer is closing, allowed paths too', async () => {
    const { mw, bus } = await middleware({ enabled: false, allow: ['/health'] });
    const server = { State: LifecycleState.Listening };
    bus.emit('http.server.listening', server);
    expect((await chai.request(app(mw)).get('/health')).status).to.eq(200);

    server.State = LifecycleState.Closing;
    bus.emit('http.server.closing', server);
    const res = await chai.request(app(mw)).get('/health');

    expect(res.status).to.eq(503);
    expect(header(res, 'connection')).to.eq('close');
    expect(header(res, 'retry-after')).to.eq(undefined);
    expect(res.body).to.deep.eq({ error: { code: 'shutting_down', message: 'The server is shutting down, try again' } });

    server.State = LifecycleState.Listening;
    bus.emit('http.server.listening', server);
    expect((await chai.request(app(mw)).get('/health')).status).to.eq(200);
  });

  it('stops listening to the server events on dispose', async () => {
    const { mw, bus } = await middleware({});
    await mw.dispose();
    bus.emit('http.server.closing', { State: LifecycleState.Closing });
    expect((await chai.request(app(mw)).get('/probe')).status).to.eq(200);
  });

  it('is always mounted: shutdown answers do not depend on http.maintenance.enabled', async () => {
    const { mw } = await middleware({ enabled: false });
    expect(mw.isEnabled()).to.eq(true);
    expect(mw.Order).to.eq(-0.5);
  });

  it('the schema refuses a negative retryAfter and an allow entry without a leading slash', async () => {
    const violations = (maintenance: unknown) => configurationViolations({ schemas: [HTTP_CONFIGURATION_SCHEMA], config: { http: { maintenance } } });
    expect(await violations({ retryAfter: -1 })).to.include('http.maintenance.retryAfter');
    expect(await violations({ allow: ['health'] })).to.include('http.maintenance.allow.0');
    expect(await violations({ enabled: true, retryAfter: 0, allow: ['/health'], message: 'x' })).to.deep.eq([]);
  });
});

let slowEntered: () => void = () => undefined;
let release: () => void = () => undefined;

@BasePath('maint')
class MaintenanceController extends BaseController {
  @Get()
  public async slow() {
    const released = new Promise<void>((resolve) => (release = resolve));
    slowEntered();
    await released;
    return new Ok({ slow: true });
  }

  @Get()
  public fast() {
    return new Ok({ fast: true });
  }
}

/** Raw HTTP/1.1 responses read from one keep-alive socket. */
function rawConnection(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  let received = '';
  socket.on('data', (chunk) => (received += chunk.toString('latin1')));
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  return {
    send: (path: string) => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nAccept: application/json\r\nConnection: keep-alive\r\n\r\n`),
    received: () => received,
    closed,
    destroy: () => socket.destroy(),
  };
}

describe('MaintenanceMode in HttpServer', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(MaintenanceController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('is registered and answers 503 after enable()', async () => {
    const mw = DI.get(MaintenanceMode)!;
    const port = appPort();
    mw.enable();
    try {
      const res = await chai.request(`http://localhost:${port}`).get('/maint/fast').set('Accept', 'application/json');
      expect(res.status).to.eq(503);
      expect(errorOf(res).code).to.eq('maintenance');
    } finally {
      mw.disable();
    }
    expect((await chai.request(`http://localhost:${port}`).get('/maint/fast').set('Accept', 'application/json')).status).to.eq(200);
  });

  // Last: it stops the server.
  it('answers a request arriving on a kept-alive connection while the server closes', async () => {
    const server = DI.get(HttpServer)!;
    const connection = rawConnection(appPort());
    try {
      const entered = new Promise<void>((resolve) => (slowEntered = resolve));
      connection.send('/maint/slow');
      await entered;

      const stopping = server.stop();
      expect(server.State).to.eq(LifecycleState.Closing);
      connection.send('/maint/fast');
      release();

      await connection.closed;
      await stopping;

      const text = connection.received();
      expect(text).to.match(/^HTTP\/1\.1 200 /);
      const second = text.slice(text.indexOf('HTTP/1.1', 1));
      expect(second).to.match(/^HTTP\/1\.1 503 /);
      expect(second.toLowerCase()).to.include('connection: close');
      expect(second).to.include('"code":"shutting_down"');
    } finally {
      connection.destroy();
    }
  });
});
