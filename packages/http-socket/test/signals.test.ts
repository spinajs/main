import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { SocketException, WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, Signal, SocketController } from '../src/decorators.js';
import { ITestServer, command, delay, errorOf, open, startServer, waitFor } from './harness.js';

export const sigAborts = new Map<string, unknown>();
export const sigGate: { release: () => void } = { release: () => undefined };

async function waitForAbort(key: string, signal: AbortSignal): Promise<string> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  sigAborts.set(key, signal.reason);
  return 'aborted';
}

@SocketController('sig')
export class SignalSocket extends BaseSocketController {
  @Command('wait')
  public async wait(@Payload() p: { key: string }, @Signal() signal: AbortSignal) {
    return waitForAbort(p.key, signal);
  }

  @Command('slow', { timeoutMs: 50 })
  public async slow(@Payload() p: { key: string }, @Signal() signal: AbortSignal) {
    return waitForAbort(p.key, signal);
  }

  // ignores its signal and settles only when the test releases it
  @Command('stubborn')
  public async stubborn() {
    await new Promise<void>((resolve) => {
      sigGate.release = resolve;
    });
    return 'late result';
  }
}

const reasonOf = (key: string) => sigAborts.get(key) as SocketException | undefined;

describe('socket command signals', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    sigGate.release = () => undefined;
    t = await startServer();
    socket = await open(t);
  });

  afterEach(async () => {
    sigGate.release();
    socket.close();
    await t.close();
  });

  it('aborts at the client deadline with a retryable deadline_exceeded', async () => {
    const started = Date.now();
    const error = errorOf(await command(socket, 'sig.wait', { key: 'd1' }, { deadline: 50 }));

    expect(error).to.include({ code: 'deadline_exceeded', retryable: true });
    expect(Date.now() - started).to.be.lessThan(1000);
    await waitFor(() => sigAborts.has('d1'));
    expect(reasonOf('d1')?.code).to.equal('deadline_exceeded');
  });

  it('aborts at the command timeoutMs', async () => {
    expect(errorOf(await command(socket, 'sig.slow', { key: 's1' })).code).to.equal('deadline_exceeded');
    await waitFor(() => sigAborts.has('s1'));
    expect(reasonOf('s1')?.code).to.equal('deadline_exceeded');
  });

  it('keeps the earlier of the client deadline and timeoutMs', async () => {
    const started = Date.now();
    expect(errorOf(await command(socket, 'sig.slow', { key: 's2' }, { deadline: 5000 })).code).to.equal('deadline_exceeded');
    expect(Date.now() - started).to.be.lessThan(1000);
  });

  it('aborts on a client cancel with cancelled', async () => {
    const pending = command(socket, 'sig.wait', { key: 'c1' }, { id: 'cancel-me' });
    await delay(50);
    socket.emit(WIRE_EVENTS.cancel, { id: 'cancel-me' });

    expect(errorOf(await pending)).to.include({ code: 'cancelled', retryable: false });
    await waitFor(() => sigAborts.has('c1'));
    expect(reasonOf('c1')?.code).to.equal('cancelled');
  });

  it('aborts running handlers when the client disconnects', async () => {
    void command(socket, 'sig.wait', { key: 'x1' }).catch(() => undefined);
    await delay(50);
    socket.disconnect();

    await waitFor(() => sigAborts.has('x1'));
    expect(reasonOf('x1')?.code).to.equal('unavailable');
  });

  it('aborts running handlers when the server is disposed', async () => {
    void command(socket, 'sig.wait', { key: 'z1' }).catch(() => undefined);
    await delay(50);
    await t.server.dispose();

    await waitFor(() => sigAborts.has('z1'));
    expect(reasonOf('z1')?.code).to.equal('unavailable');
    expect(reasonOf('z1')?.message).to.equal('server is shutting down');
  });

  it('ignores a late handler result after the deadline answered: one reply only', async () => {
    const replies: unknown[] = [];
    socket.emit(WIRE_EVENTS.command, { id: 'late-1', name: 'sig.stubborn', deadline: 50 }, (r: unknown) => replies.push(r));

    await waitFor(() => replies.length === 1);
    expect(errorOf(replies[0] as never).code).to.equal('deadline_exceeded');

    sigGate.release();
    await delay(100);
    expect(replies).to.have.length(1);
  });

  it('holds the in-flight slot after an abort until the handler settles', async () => {
    socket.close();
    await t.close();
    t = await startServer({ http: { socket: { maxInFlightPerConnection: 1 } } });
    socket = await open(t);

    expect(errorOf(await command(socket, 'sig.stubborn', undefined, { deadline: 50 })).code).to.equal('deadline_exceeded');
    expect(errorOf(await command(socket, 'sig.wait', { key: 'slot-1' })).code).to.equal('resource_exhausted');

    sigGate.release();
    await delay(50);
    expect(errorOf(await command(socket, 'sig.wait', { key: 'slot-2' }, { deadline: 50 })).code).to.equal('deadline_exceeded');
  });
});
