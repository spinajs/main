import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI, Injectable } from '@spinajs/di';
import { Metrics } from '@spinajs/telemetry-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { ISocketCommandContext, STAGE_ORDER, SocketCommandStage } from '../src/interfaces.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { ITestServer, command, open, resultOf, startServer } from './harness.js';

export const obsStageSeen: Array<{ handler: string | null; args: boolean }> = [];

@Injectable(SocketCommandStage)
export class ObsTagStage extends SocketCommandStage {
  public get Order(): number {
    return STAGE_ORDER.Lookup + 50;
  }

  public async execute(ctx: ISocketCommandContext, next: () => Promise<unknown>): Promise<unknown> {
    obsStageSeen.push({ handler: ctx.handler?.fullName ?? null, args: ctx.args !== undefined });
    ctx.storage.obsTag = 'tagged';
    return next();
  }
}

@SocketController('obs')
export class ObsSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }

  @Command('trace')
  public async trace() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).getStore();
    return { traceId: store?.traceId ?? null, tag: store?.obsTag ?? null, requestId: store?.requestId ?? null };
  }
}

describe('socket observability', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    sinon.restore();
    socket.close();
    await t.close();
  });

  it('runs a DI-registered stage at its Order, after lookup and before arguments', async () => {
    await command(socket, 'obs.echo', 1);
    expect(obsStageSeen[obsStageSeen.length - 1]).to.deep.equal({ handler: 'obs.echo', args: false });
  });

  it('carries an inbound traceparent into the handler context', async () => {
    const reply = await command(socket, 'obs.trace', undefined, { id: 'trace-1', traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
    expect(resultOf(reply)).to.deep.equal({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', tag: 'tagged', requestId: 'trace-1' });
  });

  it('starts a fresh trace without a traceparent', async () => {
    const { traceId } = resultOf(await command<{ traceId: string }>(socket, 'obs.trace'));
    expect(traceId).to.match(/^[0-9a-f]{32}$/);
  });

  it('writes one debug line per command', async () => {
    const dispatcher = await DI.resolve(SocketDispatcher);
    const debug = sinon.spy((dispatcher as unknown as { Log: { debug: (...args: unknown[]) => void } }).Log, 'debug');

    await command(socket, 'obs.echo', 1);

    const lines = debug.getCalls().map((c) => String(c.args[0]));
    expect(lines.some((line) => /^socket command obs\.echo ok \d+ms connection /.test(line))).to.be.true;
  });

  it('publishes command and connection metrics', async () => {
    await command(socket, 'obs.echo', 1);
    await command(socket, 'obs.echo', 2);
    await command(socket, 'obs.missing');

    const text = await (DI.resolve(Metrics) as Metrics).render();
    expect(text).to.contain('socket_commands_total{command="obs.echo",code="ok"} 2');
    expect(text).to.contain('socket_commands_total{command="unknown",code="unimplemented"} 1');
    expect(text).to.contain('socket_command_duration_seconds_count{command="obs.echo"} 2');
    expect(text).to.contain('socket_connections 1');
  });

  it('never puts a client-chosen command name into a label', async () => {
    await command(socket, 'obs.attacker-chosen-name');

    const text = await (DI.resolve(Metrics) as Metrics).render();
    expect(text).to.not.contain('attacker-chosen-name');
  });

  it('labels a refusal before lookup by the registered command and its error code', async () => {
    await command(socket, 'obs.echo', 'x'.repeat(2 * 1024 * 1024 - 100));

    const text = await (DI.resolve(Metrics) as Metrics).render();
    expect(text).to.contain('socket_commands_total{command="obs.echo",code="resource_exhausted"} 1');
  });

  it('releases the connection gauge on disconnect', async () => {
    socket.close();
    const until = Date.now() + 2000;
    let text = '';
    do {
      await new Promise((r) => setTimeout(r, 20));
      text = await (DI.resolve(Metrics) as Metrics).render();
    } while (!text.includes('socket_connections 0') && Date.now() < until);

    expect(text).to.contain('socket_connections 0');
  });
});
