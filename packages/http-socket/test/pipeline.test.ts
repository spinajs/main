import 'mocha';
import { expect } from 'chai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Socket as ClientSocket } from 'socket.io-client';
import { DI } from '@spinajs/di';
import { Forbidden } from '@spinajs/exceptions';
import { UNATTENDED } from '@spinajs/authz';
import { WIRE_EVENTS } from '@spinajs/http-socket-common';
import { BaseSocketController } from '../src/controller.js';
import { Command, Connection, Payload, SocketController } from '../src/decorators.js';
import { SocketConnection } from '../src/connection.js';
import { ISocketCallStorage, SocketHttpHost } from '../src/interfaces.js';
import { ALICE, ITestServer, TestHttpHost, command, delay, errorOf, open, resultOf, startServer } from './harness.js';

const PIPE_HOLD: { release?: () => void } = {};

export class PipeNote {
  public text: string;

  constructor(data: Partial<PipeNote>) {
    Object.assign(this, data);
  }
}

@SocketController('pipe')
export class PipelineSocket extends BaseSocketController {
  @Command('echo')
  public async echo(@Payload() payload: unknown) {
    return payload;
  }

  @Command('nothing')
  public async nothing(): Promise<void> {}

  @Command('validated', { schema: { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 1 } } } })
  public async validated(@Payload() p: { n: number }) {
    return p.n * 2;
  }

  @Command('forbid')
  public async forbid(): Promise<void> {
    throw new Forbidden('not yours');
  }

  @Command('boom')
  public async boom(): Promise<void> {
    throw new Error('kaput');
  }

  @Command('who')
  public async who(@Connection() conn: SocketConnection) {
    return { clientId: conn.clientId, user: conn.user ?? null };
  }

  @Command('note')
  public async note(@Payload() note: PipeNote) {
    return note instanceof PipeNote ? note.text : 'not hydrated';
  }

  @Command('stream')
  public async *stream() {
    yield 1;
  }

  @Command('store')
  public async store() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<Record<string, unknown>>).getStore();
    return { requestId: store?.requestId ?? null, connectionId: store?.connectionId ?? null };
  }

  @Command('bigint')
  public async bigint() {
    return 1n;
  }

  @Command('circular')
  public async circular() {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    return loop;
  }

  @Command('hold')
  public async hold() {
    await new Promise<void>((resolve) => {
      PIPE_HOLD.release = resolve;
    });
    return 'held';
  }

  @Command('principal')
  public async principal() {
    const store = (DI.resolve(AsyncLocalStorage) as AsyncLocalStorage<ISocketCallStorage>).getStore();
    return { id: store?.Principal.id ?? null, unattended: store?.Principal === UNATTENDED, authn: store?.AuthnPrincipal?.id ?? null };
  }
}

export class PipeDupOne extends BaseSocketController {
  @Command('pipe-dup.same')
  public async one(): Promise<void> {}
}

export class PipeDupTwo extends BaseSocketController {
  @Command('pipe-dup.same')
  public async two(): Promise<void> {}
}

describe('socket server startup', function () {
  this.timeout(15000);

  it('aborts when the handler registry refuses to build, before socket.io attaches', async () => {
    DI.register(PipeDupOne).as(BaseSocketController);
    DI.register(PipeDupTwo).as(BaseSocketController);
    try {
      await expect(startServer()).to.be.rejectedWith(/pipe-dup\.same is declared twice/);
      const host = DI.resolve(SocketHttpHost) as TestHttpHost;
      expect(host.Http.listenerCount('request')).to.equal(0);
      expect(host.Http.listenerCount('upgrade')).to.equal(0);
    } finally {
      DI.unregister(PipeDupOne);
      DI.unregister(PipeDupTwo);
    }
  });
});

describe('socket command pipeline', function () {
  this.timeout(15000);

  let t: ITestServer;
  let socket: ClientSocket;

  beforeEach(async () => {
    t = await startServer();
    socket = await open(t, { auth: { token: 'good', clientId: 'pipe-client' } });
  });

  afterEach(async () => {
    socket.close();
    await t.close();
  });

  it('answers a command with its result and echoes the request id', async () => {
    const reply = await command(socket, 'pipe.echo', { a: 1 }, { id: 'echo-1' });
    expect(reply).to.deep.equal({ id: 'echo-1', ok: true, result: { a: 1 } });
  });

  it('sends null for a handler that returns nothing', async () => {
    expect(resultOf(await command(socket, 'pipe.nothing'))).to.be.null;
  });

  it('answers an unknown command with unimplemented', async () => {
    expect(errorOf(await command(socket, 'pipe.nope'))).to.deep.equal({ code: 'unimplemented', message: 'unknown command pipe.nope', retryable: false });
  });

  it('validates the payload and returns the validation details', async () => {
    const error = errorOf(await command(socket, 'pipe.validated', { n: 0 }));
    expect(error.code).to.equal('invalid_argument');
    expect((error.details as Array<{ rule: string }>)[0].rule).to.equal('minimum');
    expect(resultOf(await command(socket, 'pipe.validated', { n: 2 }))).to.equal(4);
  });

  it('maps a thrown spinajs exception', async () => {
    expect(errorOf(await command(socket, 'pipe.forbid'))).to.deep.equal({ code: 'forbidden', message: 'not yours', retryable: false });
  });

  it('maps an unexpected error to internal with an errorId', async () => {
    const error = errorOf(await command(socket, 'pipe.boom'));
    expect(error.code).to.equal('internal');
    expect(error.message).to.equal('kaput');
    expect(error.errorId).to.be.a('string');
  });

  it('passes the connection and its identity', async () => {
    expect(resultOf(await command(socket, 'pipe.who'))).to.deep.equal({ clientId: 'pipe-client', user: ALICE });
  });

  it('hydrates a DTO payload', async () => {
    expect(resultOf(await command(socket, 'pipe.note', { text: 'hello' }))).to.equal('hello');
  });

  it('answers a stream-returning handler with unimplemented until W4', async () => {
    const error = errorOf(await command(socket, 'pipe.stream'));
    expect(error.code).to.equal('unimplemented');
    expect(error.message).to.match(/stream replies/);
  });

  it('runs the handler inside the call storage', async () => {
    expect(resultOf(await command(socket, 'pipe.store', undefined, { id: 'store-1' }))).to.deep.equal({ requestId: 'store-1', connectionId: socket.id });
  });

  it('puts the connection principal into the call storage under Principal and AuthnPrincipal (D14)', async () => {
    expect(resultOf(await command(socket, 'pipe.principal'))).to.deep.equal({ id: '1', unattended: false, authn: '1' });
  });

  it('runs a connection without credentials as UNATTENDED, with no AuthnPrincipal', async () => {
    const anonymous = await open(t, { auth: { clientId: 'pipe-anon' } });
    try {
      expect(resultOf(await command(anonymous, 'pipe.principal'))).to.deep.equal({ id: 'unattended', unattended: true, authn: null });
    } finally {
      anonymous.close();
    }
  });

  it('answers a malformed request with invalid_argument', async () => {
    const reply = await socket.timeout(2000).emitWithAck(WIRE_EVENTS.command, { name: 'pipe.echo' });
    expect(reply).to.deep.equal({ id: '', ok: false, error: { code: 'invalid_argument', message: 'malformed command request', retryable: false } });
  });

  for (const name of ['bigint', 'circular']) {
    it(`answers a ${name} result that cannot be encoded with internal, without an unhandled rejection`, async () => {
      const rejections: unknown[] = [];
      const onRejection = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', onRejection);
      try {
        const error = errorOf(await command(socket, `pipe.${name}`));
        expect(error.code).to.equal('internal');
        expect(error.errorId).to.be.a('string');
        await delay(50);
        expect(rejections).to.deep.equal([]);
      } finally {
        process.off('unhandledRejection', onRejection);
      }
    });
  }

  it('refuses a command whose id is already in flight and keeps the first one running', async () => {
    const first = command(socket, 'pipe.hold', undefined, { id: 'dup-1' });
    await delay(50);
    const second = await command(socket, 'pipe.echo', 1, { id: 'dup-1' });
    expect(errorOf(second)).to.deep.equal({ code: 'invalid_argument', message: 'request id already in flight', retryable: false });
    PIPE_HOLD.release?.();
    expect(resultOf(await first)).to.equal('held');
    expect(resultOf(await command(socket, 'pipe.echo', 2, { id: 'dup-1' }))).to.equal(2);
  });

  it('carries binary payload parts both ways', async () => {
    const result = resultOf(await command<{ bin: ArrayBuffer }>(socket, 'pipe.echo', { bin: new Uint8Array([1, 2, 3]) }));
    expect(Array.from(new Uint8Array(result.bin))).to.deep.equal([1, 2, 3]);
  });
});
