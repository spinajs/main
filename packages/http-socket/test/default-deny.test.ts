import 'mocha';
import { expect } from 'chai';
import sinon from 'sinon';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { BasePolicy } from '@spinajs/http';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, OnEvent, SocketController, SocketPolicy } from '../src/decorators.js';
import { SocketHandlerRegistry } from '../src/registry.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer } from './harness.js';
import { logText } from './log-text.js';
import socketConfig from '../src/config/http-socket.js';

export const denyRan: string[] = [];

export class DenyAllow extends BasePolicy {
  public isEnabled(): boolean {
    return true;
  }

  public async execute(): Promise<void> {}
}

export class DenyOff extends BasePolicy {
  public isEnabled(): boolean {
    return false;
  }

  public async execute(): Promise<void> {}
}

@SocketController('nopol')
export class NoPolicySocket extends BaseSocketController {
  @Command('run', { idempotent: true })
  public async run() {
    denyRan.push('run');
    return 'ran';
  }

  @Command('guarded')
  @SocketPolicy(DenyAllow)
  public async guarded() {
    return 'guarded';
  }

  @Command('off')
  @SocketPolicy(DenyOff)
  public async off() {
    denyRan.push('off');
    return 'off';
  }

  @OnEvent('poke')
  public async poke() {
    denyRan.push('poke');
  }
}

@SocketController('clspol')
@SocketPolicy(DenyAllow)
export class ClassPolicySocket extends BaseSocketController {
  @Command('run')
  public async run() {
    return 'class guarded';
  }
}

describe('http.socket.access.default', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  const start = async (mode: 'allow' | 'deny') => {
    t = await startServer({ http: { socket: { access: { default: mode } } } });
    socket = await open(t, { auth: { clientId: 'nopol-client', token: 'good' } });
  };

  beforeEach(() => {
    denyRan.length = 0;
  });

  afterEach(async () => {
    sinon.restore();
    socket?.close();
    await t?.close();
  });

  it("ships 'deny'", () => {
    expect(socketConfig.http.socket.access).to.deep.equal({ default: 'deny' });
  });

  it("denies a command no policy guards with AccessDenied 'no_policy' before the handler runs", async () => {
    await start('deny');
    const error = errorOf(await command(socket, 'nopol.run'));
    expect(error).to.deep.include({ code: 'forbidden', retryable: false });
    expect(error.details).to.deep.include({ permission: '', resource: { type: 'socket', id: 'nopol.run' }, reason: { code: 'no_policy' } });
    expect(denyRan).to.deep.equal([]);
  });

  it('treats a command whose only policy is disabled as unguarded', async () => {
    await start('deny');
    expect(errorOf(await command(socket, 'nopol.off')).details).to.deep.include({ reason: { code: 'no_policy' } });
    expect(denyRan).to.deep.equal([]);
  });

  it('runs a command guarded on itself or on its class', async () => {
    await start('deny');
    expect(resultOf(await command(socket, 'nopol.guarded'))).to.equal('guarded');
    expect(resultOf(await command(socket, 'clspol.run'))).to.equal('class guarded');
  });

  it('drops an event no policy guards', async () => {
    await start('deny');
    socket.emit(WIRE_EVENTS.event, { name: 'nopol.poke', payload: null });
    await delay(200);
    expect(denyRan).to.deep.equal([]);
  });

  it("runs unguarded commands and events under 'allow'", async () => {
    await start('allow');
    expect(resultOf(await command(socket, 'nopol.run'))).to.equal('ran');
    socket.emit(WIRE_EVENTS.event, { name: 'nopol.poke', payload: null });
    await delay(200);
    expect(denyRan).to.deep.equal(['run', 'poke']);
  });

  it('reports the unguarded commands and events at boot', async () => {
    await start('deny');
    const registry = DI.get(SocketHandlerRegistry)!;
    const names = registry.unguarded().map((h) => h.fullName);
    expect(names).to.include.members(['nopol.run', 'nopol.poke']);
    expect(names).to.not.include.members(['nopol.guarded', 'nopol.off', 'clspol.run']);

    const warn = sinon.spy((registry as unknown as { Log: { warn: (...args: unknown[]) => void } }).Log, 'warn');
    await registry.build();
    expect(warn.getCalls().map((c) => logText(c.args))).to.include('Socket command nopol.run ( NoPolicySocket ) has no @SocketAccess or @SocketPolicy and is denied ( http.socket.access.default is deny )');
  });
});
