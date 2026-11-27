import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IQueueConnectionOptions } from '@spinajs/queue';
import type { ChannelModel, Options } from 'amqplib';
import { expect } from 'chai';
import dns from 'dns';
import { createServer, LookupFunction, Server } from 'net';
import { inspect } from 'util';
import { AmqpQueueClient } from '../src/connection.js';

const BROKEN_USERINFO = "the host url has an '@' after the host: percent-encode a '/', '?', '#' or '@' in its userinfo, vhost or query";

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return { logger: { targets: [{ name: 'Empty', type: 'BlackHoleTarget' }], rules: [{ name: '*', level: 'trace', target: 'Empty' }] } };
  }
}

/** Keeps the connect targets it is handed; amqplib still dials them through the socket options' lookup. */
class RecordingClient extends AmqpQueueClient {
  public Targets: Array<string | Options.Connect> = [];
  public LogCalls: unknown[] = [];

  protected createConnection(url: string | Options.Connect, socketOptions: Record<string, unknown>): Promise<ChannelModel> {
    this.Targets.push(url);
    return super.createConnection(url, socketOptions);
  }
}

interface Attempt {
  client: RecordingClient;
  thrown: unknown;
  looked: string[];
  ms: number;
}

const hostnames = (client: RecordingClient): unknown[] => client.Targets.map((target) => (typeof target === 'string' ? target : target.hostname));

describe('amqp transport - a host that is not a url is refused before any dial', function () {
  this.timeout(30000);
  const servers: Server[] = [];
  let port = 0;
  let port6 = 0;
  let accepted = 0;
  const resolverCalls: string[] = [];
  const systemLookup = dns.lookup;

  before(async () => {
    port = await listen('127.0.0.1');
    port6 = await listen('::1');
    // the system resolver is never asked: a socket that skipped the injected lookup is recorded and fails here
    Object.defineProperty(dns, 'lookup', {
      configurable: true,
      writable: true,
      value: (hostname: string, ...rest: unknown[]) => {
        resolverCalls.push(hostname);
        const callback = rest[rest.length - 1];
        if (typeof callback === 'function') callback(Object.assign(new Error('the system resolver is not used in this test'), { code: 'ENOTFOUND' }));
      },
    });
  });

  after(async () => {
    Object.defineProperty(dns, 'lookup', { configurable: true, writable: true, value: systemLookup });
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function listen(host: string): Promise<number> {
    const server = createServer((socket) => {
      accepted++;
      socket.destroy();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(() => {
    expect(resolverCalls).to.deep.eq([]);
  });

  async function attempt(options: Partial<IQueueConnectionOptions>): Promise<Attempt> {
    const looked: string[] = [];
    const lookup: LookupFunction = (hostname, _options, callback) => {
      looked.push(hostname);
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname }), '', 4);
    };
    const client = new RecordingClient({ service: 'AmqpQueueClient', name: 'orders', reconnectDelay: 10, ...options, options: { lookup, timeout: 2000, ...options.options } });
    const record =
      (level: string) =>
      (vars: unknown, template?: unknown): void =>
        void client.LogCalls.push({ level, vars, template });
    Object.defineProperty(client, 'Log', { value: Object.fromEntries(['trace', 'debug', 'info', 'success', 'warn', 'error', 'fatal', 'security'].map((level) => [level, record(level)])) });

    const start = Date.now();
    const thrown = await client.resolve().then(
      () => undefined,
      (error: unknown) => error,
    );
    const ms = Date.now() - start;
    // a reconnect loop would dial again within a few reconnectDelay periods
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.dispose();
    return { client, thrown, looked, ms };
  }

  const refused: Array<[form: string, host: () => string, planted: string[], hint: boolean]> = [
    ['an invalid port', () => 'amqp://planted-user:planted-secret@127.0.0.1:99999/vh', ['planted-user', 'planted-secret'], false],
    ['an unencoded / in the password', () => `amqp://planted-user:pa/ss@127.0.0.1:${port}/vh`, ['planted-user', 'pa/ss'], false],
    ['an unencoded ? in the password', () => `amqp://planted-user:planted?secret@127.0.0.1:${port}/vh`, ['planted-user', 'planted?secret'], false],
    ['an unencoded # in the password', () => `amqp://planted-user:planted#secret@127.0.0.1:${port}/vh`, ['planted-user', 'planted#secret'], false],
    ['an amqps url with an unencoded / in the password', () => `amqps://planted-user:pa/ss@127.0.0.1:${port}/vh`, ['planted-user', 'pa/ss'], false],
    ['an unencoded / in the user name', () => `amqp://planted-user/ss@127.0.0.1:${port}/vh`, ['planted-user'], true],
    ['a digits-only password start before an unencoded /', () => `amqp://planted-user:65001/planted-secret@127.0.0.1:${port}/vh`, ['planted-user', 'planted-secret', '65001'], true],
    ['a token with an unencoded #', () => `amqp://planted-secret#tail@127.0.0.1:${port}/vh`, ['planted-secret'], true],
    ['an unencoded @ in the vhost', () => 'amqp://planted-user:planted-secret@rabbit.internal.invalid/vh@x', ['planted-user', 'planted-secret'], true],
  ];

  for (const [form, host, planted, hint] of refused) {
    it(`refuses ${form} at once: nothing is dialled or looked up, nothing planted is shown`, async () => {
      const before = accepted;
      const { client, thrown, looked, ms } = await attempt({ host: host() });

      expect(looked, `asked the resolver for ${looked.join(', ')}`).to.deep.eq([]);
      expect(client.Targets).to.deep.eq([]);
      expect(accepted).to.eq(before);
      expect(thrown).to.be.instanceOf(InvalidArgument);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).to.eq(`Queue connection orders has a host that is not a URL: <not a URL>${hint ? `; ${BROKEN_USERINFO}` : ''}`);
      expect(ms).to.be.lessThan(1000);
      const text = inspect([thrown, client.LogCalls], { depth: 6, showHidden: true });
      for (const value of planted) expect(text).to.not.contain(value);
    });
  }

  const dialled: Array<[form: string, options: () => Partial<IQueueConnectionOptions>, hostname: string, looked: string[]]> = [
    ['an amqp url', () => ({ host: `amqp://planted-user:planted-secret@127.0.0.1:${port}/vh` }), '127.0.0.1', []],
    ['an amqps url', () => ({ host: `amqps://planted-user:planted-secret@127.0.0.1:${port}/vh`, options: { servername: 'localhost' } }), '127.0.0.1', []],
    ['an upper-case scheme', () => ({ host: `AMQP://127.0.0.1:${port}` }), '127.0.0.1', []],
    ['a host name with a port', () => ({ host: 'amqp://planted-user:planted-secret@rabbit.internal.invalid:5672/vh' }), 'rabbit.internal.invalid', ['rabbit.internal.invalid']],
    ['a percent-encoded / in the password', () => ({ host: `amqp://planted-user:pa%2Fss@127.0.0.1:${port}/vh` }), '127.0.0.1', []],
    ['a percent-encoded ?, # and @ in the password', () => ({ host: `amqp://planted-user:pa%3Fss%23x%40y@127.0.0.1:${port}/vh` }), '127.0.0.1', []],
    ['the default vhost written /%2F', () => ({ host: `amqp://127.0.0.1:${port}/%2F` }), '127.0.0.1', []],
    ['a percent-encoded @ in the vhost', () => ({ host: 'amqp://rabbit.internal.invalid/vh%40x' }), 'rabbit.internal.invalid', ['rabbit.internal.invalid']],
    ['an IPv6 literal', () => ({ host: `amqp://planted-user:planted-secret@[::1]:${port6}/vh` }), '::1', []],
    ['discrete fields', () => ({ host: 'rabbit.internal.invalid', login: 'planted-user', password: 'planted-secret' }), 'rabbit.internal.invalid', ['rabbit.internal.invalid']],
    ['no host at all', () => ({}), 'localhost', ['localhost']],
    ['a host in the socket options', () => ({ host: `amqp://127.0.0.1:${port}/vh`, options: { host: 'other.internal.invalid' } }), '127.0.0.1', []],
  ];

  for (const [form, options, hostname, looked] of dialled) {
    it(`still dials ${form}`, async () => {
      const before = accepted;
      const result = await attempt(options());

      expect(hostnames(result.client)).to.deep.eq([hostname]);
      expect(result.looked).to.deep.eq(looked);
      if (looked.length === 0) expect(accepted - before).to.eq(1);
      expect(result.thrown).to.not.be.instanceOf(InvalidArgument);
    });
  }
});
