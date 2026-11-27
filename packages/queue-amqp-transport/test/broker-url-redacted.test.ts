import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { IQueueConnectionOptions } from '@spinajs/queue';
import { expect } from 'chai';
import { LookupFunction } from 'net';
import { inspect } from 'util';
import { AmqpQueueClient } from '../src/connection.js';
import { BrokerScript, closedPort, fakeBroker, FakeBroker } from './support/fake-broker.js';

const PLANTED = ['planted-user', 'planted-secret'];

interface LogCall {
  level: string;
  vars: unknown;
  template: unknown;
}

class ConnectionConf extends FrameworkConfiguration {
  protected onLoad(): unknown {
    return {
      logger: {
        targets: [{ name: 'Empty', type: 'BlackHoleTarget' }],
        rules: [{ name: '*', level: 'trace', target: 'Empty' }],
      },
    };
  }
}

/** Keeps every call the client makes on its logger, with the very objects it passes. */
function recordingClient(options: Partial<IQueueConnectionOptions>): { client: AmqpQueueClient; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const client = new AmqpQueueClient({ service: 'AmqpQueueClient', name: `amqp-redacted-${Date.now()}`, reconnectDelay: 20, ...options });
  const record =
    (level: string) =>
    (vars: unknown, template?: unknown): void =>
      void calls.push({ level, vars, template });
  const log = Object.fromEntries(['trace', 'debug', 'info', 'success', 'warn', 'error', 'fatal', 'security'].map((level) => [level, record(level)]));
  Object.defineProperty(client, 'Log', { value: log });
  return { client, calls };
}

async function failedConnect(options: Partial<IQueueConnectionOptions>): Promise<{ calls: LogCall[]; thrown: unknown }> {
  const { client, calls } = recordingClient(options);
  const thrown = await client.resolve().then(
    () => new Error('connected'),
    (error: unknown) => error,
  );
  await client.dispose();
  return { calls, thrown };
}

function expectNothingPlanted(...captured: unknown[]): void {
  const text = inspect(captured, { depth: 6, showHidden: true });
  for (const planted of PLANTED) expect(text).to.not.contain(planted);
  expect(text).to.not.contain('heartbeat=5');
}

function connectingHosts(calls: LogCall[]): unknown[] {
  return calls.filter((call) => call.level === 'info' && String(call.template).startsWith('Connecting')).map((call) => (isObject(call.vars) && 'host' in call.vars ? call.vars.host : undefined));
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

function messageOf(error: unknown): string {
  expect(error).to.be.instanceOf(Error);
  return error instanceof Error ? error.message : '';
}

/** The cause the thrown connect error carries: what the operator reads to tell one failure from another. */
function causeOf(thrown: unknown): { name: string; message: string; code?: unknown } {
  expect(thrown).to.be.instanceOf(Error);
  const cause = thrown instanceof Error ? thrown.cause : undefined;
  expect(cause).to.be.instanceOf(Error);
  if (!(cause instanceof Error)) throw new Error('no cause');
  return { name: cause.name, message: cause.message, code: 'code' in cause ? cause.code : undefined };
}

const urlOf = (port: number | string): string => `amqp://planted-user:planted-secret@127.0.0.1:${port}/vhost?heartbeat=5`;
const shownAs = (port: number): string => `amqp://127.0.0.1:${port}/vhost`;

describe('amqp transport - the broker url in logs and errors', function () {
  this.timeout(30000);
  const brokers: FakeBroker[] = [];

  async function broker(scripts: BrokerScript[]): Promise<number> {
    const started = await fakeBroker(scripts);
    brokers.push(started);
    return started.port;
  }

  beforeEach(async () => {
    DI.clearCache();
    DI.register(ConnectionConf).as(Configuration);
    await DI.resolve(Configuration);
  });

  afterEach(async () => {
    await Promise.all(brokers.splice(0).map((b) => b.close()));
  });

  it('a refused connection: the line and the error show the broker without userinfo and query', async () => {
    const port = await closedPort();
    const { calls, thrown } = await failedConnect({ host: urlOf(port) });

    expectNothingPlanted(calls, thrown);
    expect(connectingHosts(calls)).to.deep.eq([shownAs(port)]);
    expect(messageOf(thrown)).to.eq(`Cannot connect to AMQP queue server at ${shownAs(port)}`);
    expect(causeOf(thrown)).to.deep.include({ code: 'ECONNREFUSED', message: `connect ECONNREFUSED 127.0.0.1:${port}` });
  });

  it('a listener that closes the socket at once', async () => {
    const port = await broker(['close-at-once']);
    const { calls, thrown } = await failedConnect({ host: urlOf(port) });

    expectNothingPlanted(calls, thrown);
    expect(connectingHosts(calls)).to.deep.eq([shownAs(port)]);
    expect(causeOf(thrown).message).to.match(/Socket closed abruptly during opening handshake|ECONNRESET/);
  });

  it('a listener that never answers', async () => {
    const port = await broker(['silent']);
    const { calls, thrown } = await failedConnect({ host: urlOf(port), options: { timeout: 300 } });

    expectNothingPlanted(calls, thrown);
    expect(causeOf(thrown).message).to.eq('connect ETIMEDOUT');
  });

  it('a refused login stays an ACCESS_REFUSED', async () => {
    const port = await broker(['refuse-login']);
    const { calls, thrown } = await failedConnect({ host: urlOf(port) });

    expectNothingPlanted(calls, thrown);
    expect(causeOf(thrown).message).to.contain('403 (ACCESS-REFUSED)');
  });

  it('a missing vhost stays a connection.close in answer to connection.open', async () => {
    const port = await broker(['no-vhost']);
    const { calls, thrown } = await failedConnect({ host: urlOf(port) });

    expectNothingPlanted(calls, thrown);
    expect(causeOf(thrown).message).to.eq('Expected ConnectionOpenOk; got <ConnectionClose channel:0>');
  });

  it('a url that does not parse is never printed, nor its echo in the lookup error', async () => {
    // a lookup error as getaddrinfo builds it, without asking a DNS server for the planted name
    const lookup: LookupFunction = (hostname, _options, callback) =>
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname }), '', 4);
    const { calls, thrown } = await failedConnect({ host: urlOf(99999), options: { lookup } });

    expectNothingPlanted(calls, thrown);
    expect(connectingHosts(calls)).to.deep.eq(['<not a URL>']);
    expect(causeOf(thrown)).to.deep.eq({ name: 'Error', code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND <not a URL>' });
  });

  it('discrete fields: the line shows scheme, host, port and vhost, never the password', async () => {
    const port = await closedPort();
    const { calls, thrown } = await failedConnect({ host: '127.0.0.1', port, login: 'planted-user', password: 'planted-secret', options: { vhost: 'vhost' } });

    expectNothingPlanted(calls, thrown);
    expect(connectingHosts(calls)).to.deep.eq([shownAs(port)]);
    expect(causeOf(thrown).code).to.eq('ECONNREFUSED');
  });

  it('every reconnect after a heartbeat timeout logs the broker redacted, and each failure by its kind', async () => {
    const port = await broker(['open', 'close-at-once', 'refuse-login', 'no-vhost']);
    const { client, calls } = recordingClient({ host: urlOf(port) });
    await client.resolve();
    expect(client.IsConnected).to.be.true;

    const failures = () => calls.filter((call) => call.level === 'error' && String(call.template).startsWith('AMQP reconnect'));
    for (const deadline = Date.now() + 20000; failures().length < 3 && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 50));
    await client.dispose();

    expectNothingPlanted(calls);
    const hosts = connectingHosts(calls);
    expect(hosts.length).to.be.greaterThan(3);
    expect(hosts.every((host) => host === shownAs(port))).to.be.true;
    expect(calls.some((call) => call.level === 'success' && String(call.template).startsWith('Connected to AMQP broker'))).to.be.true;

    const reasons = failures()
      .slice(0, 3)
      .map((call) => {
        const error = isObject(call.vars) && 'error' in call.vars ? call.vars.error : undefined;
        expect(messageOf(error)).to.eq(`Cannot connect to AMQP queue server at ${shownAs(port)}`);
        return causeOf(error).message;
      });
    expect(reasons[0]).to.match(/Socket closed abruptly during opening handshake|ECONNRESET/);
    expect(reasons[1]).to.contain('403 (ACCESS-REFUSED)');
    expect(reasons[2]).to.eq('Expected ConnectionOpenOk; got <ConnectionClose channel:0>');
    expect(calls.some((call) => call.level === 'error' && inspect(call.vars).includes('Heartbeat timeout'))).to.be.true;
  });
});
