import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { SerialQueue } from '../src/queue.js';
import { DI } from '@spinajs/di';
import { SocketCommandStage } from '../src/interfaces.js';
import { SocketDispatcher } from '../src/dispatcher.js';
import { assertOrderingConfig } from '../src/limits.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer } from './harness.js';

export const ordDone: string[] = [];

interface IOrdStep {
  tag: string;
  ms: number;
}

let gate: { promise: Promise<void>; open: () => void };
const gated: Promise<void>[] = [];

function newGate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  gate = { promise, open };
}

function gatedHandler(tag: string): Promise<string> {
  const run = (async () => {
    await gate.promise;
    ordDone.push(tag);
    return tag;
  })();
  gated.push(run.then(() => undefined));
  return run;
}

async function step(p: IOrdStep): Promise<string> {
  await delay(p.ms);
  ordDone.push(p.tag);
  return p.tag;
}

@SocketController('ord')
export class OrderingSocket extends BaseSocketController {
  @Command('conn', { ordered: 'connection' })
  public async conn(@Payload() p: IOrdStep) {
    return step(p);
  }

  @Command('client', { ordered: 'client' })
  public async client(@Payload() p: IOrdStep) {
    return step(p);
  }

  @Command('hang', { ordered: 'connection', timeoutMs: 50 })
  public async hang() {
    return gatedHandler('hang');
  }

  @Command('gate', { ordered: 'client' })
  public async gateCmd() {
    return gatedHandler('gate');
  }

  @Command('free')
  public async free(@Payload() p: IOrdStep) {
    return step(p);
  }
}

describe('SerialQueue', () => {
  const task = (log: string[], tag: string, ms: number) => async () => {
    log.push(`${tag}:start`);
    await delay(ms);
    log.push(`${tag}:end`);
    return tag;
  };

  it('runs tasks with one key one after another', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    expect(await Promise.all([queue.run('k', task(log, 'A', 30)), queue.run('k', task(log, 'B', 0))])).to.deep.equal(['A', 'B']);
    expect(log).to.deep.equal(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('runs different keys side by side', async () => {
    const queue = new SerialQueue();
    const log: string[] = [];
    await Promise.all([queue.run('k1', task(log, 'A', 30)), queue.run('k2', task(log, 'B', 0))]);
    expect(log.indexOf('B:end')).to.be.lessThan(log.indexOf('A:end'));
  });

  it('does not let a failed task block the next one', async () => {
    const queue = new SerialQueue();
    const failed = queue.run('k', async () => {
      throw new Error('fail');
    });
    const next = queue.run('k', async () => 'b');
    await expect(failed).to.be.rejectedWith('fail');
    expect(await next).to.equal('b');
  });

  it('forgets a key once its queue drains', async () => {
    const queue = new SerialQueue();
    await queue.run('k', async () => 1);
    await delay(0);
    expect(queue.Size).to.equal(0);
  });
});

describe('socket ordered commands', function () {
  this.timeout(15000);

  let t: ITestServer;
  let sockets: ClientSocket[] = [];

  const connectAs = async (clientId: string, token?: string) => {
    const socket = await open(t, { auth: { clientId, ...(token ? { token } : {}) } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    ordDone.length = 0;
    gated.length = 0;
    newGate();
    t = await startServer();
  });

  afterEach(async () => {
    gate.open();
    await Promise.all(gated);
    sockets.forEach((s) => s.close());
    sockets = [];
    await t.close();
  });

  it('lets unordered commands finish in any order', async () => {
    const s = await connectAs('ord-free');
    await Promise.all([command(s, 'ord.free', { tag: 'A', ms: 80 }), command(s, 'ord.free', { tag: 'B', ms: 0 })]);
    expect(ordDone).to.deep.equal(['B', 'A']);
  });

  it("runs ordered: 'connection' commands in send order", async () => {
    const s = await connectAs('ord-conn');
    await Promise.all([command(s, 'ord.conn', { tag: 'A', ms: 80 }), command(s, 'ord.conn', { tag: 'B', ms: 0 })]);
    expect(ordDone).to.deep.equal(['A', 'B']);
  });

  it("runs ordered: 'client' commands in order across connections of one clientId", async () => {
    const first = await connectAs('ord-same');
    const second = await connectAs('ord-same');
    const a = command(first, 'ord.client', { tag: 'A', ms: 80 });
    await delay(20);
    const b = command(second, 'ord.client', { tag: 'B', ms: 0 });
    await Promise.all([a, b]);
    expect(ordDone).to.deep.equal(['A', 'B']);
  });

  it("keeps different clientIds independent under ordered: 'client'", async () => {
    const first = await connectAs('ord-x');
    const second = await connectAs('ord-y');
    const a = command(first, 'ord.client', { tag: 'A', ms: 80 });
    await delay(20);
    const b = command(second, 'ord.client', { tag: 'B', ms: 0 });
    await Promise.all([a, b]);
    expect(ordDone).to.deep.equal(['B', 'A']);
  });

  it("keeps different principals with the same clientId independent under ordered: 'client'", async () => {
    const first = await connectAs('ord-shared', 'good');
    const second = await connectAs('ord-shared');
    const a = command(first, 'ord.client', { tag: 'A', ms: 80 });
    await delay(20);
    const b = command(second, 'ord.client', { tag: 'B', ms: 0 });
    await Promise.all([a, b]);
    expect(ordDone).to.deep.equal(['B', 'A']);
  });

  it("runs ordered: 'client' commands in order across connections of one principal and clientId", async () => {
    const first = await connectAs('ord-alice', 'good');
    const second = await connectAs('ord-alice', 'good');
    const a = command(first, 'ord.client', { tag: 'A', ms: 80 });
    await delay(20);
    const b = command(second, 'ord.client', { tag: 'B', ms: 0 });
    await Promise.all([a, b]);
    expect(ordDone).to.deep.equal(['A', 'B']);
  });

  it('skips a queued command whose deadline passed while it waited', async () => {
    const s = await connectAs('ord-late');
    const a = command(s, 'ord.conn', { tag: 'A', ms: 150 });
    const b = command(s, 'ord.conn', { tag: 'B', ms: 0 }, { deadline: 50 });

    expect(errorOf(await b).code).to.equal('deadline_exceeded');
    expect(resultOf(await a)).to.equal('A');
    await delay(50);
    expect(ordDone).to.deep.equal(['A']);
  });

  const orderingStage = async () => {
    const dispatcher = (await DI.resolve(SocketDispatcher)) as unknown as { Stages: SocketCommandStage[] };
    return dispatcher.Stages.find((x) => x.constructor.name === 'OrderingStage') as unknown as { Queue: SerialQueue; Log: { error: (...args: unknown[]) => void } };
  };

  it('keeps the place of an aborted command until its handler settles', async () => {
    const s = await connectAs('ord-abort');
    const a = command(s, 'ord.hang');
    const b = command(s, 'ord.conn', { tag: 'B', ms: 0 });

    expect(errorOf(await a).code).to.equal('deadline_exceeded');
    await delay(150);
    expect(ordDone).to.deep.equal([]);

    gate.open();
    expect(resultOf(await b)).to.equal('B');
    expect(ordDone).to.deep.equal(['hang', 'B']);
  });

  it('releases the place after the abort grace and logs the key and command', async () => {
    await t.close();
    t = await startServer({ http: { socket: { ordering: { abortGraceMs: 200 } } } });
    const stage = await orderingStage();
    const logged: unknown[][] = [];
    const original = stage.Log.error;
    stage.Log.error = (...args: unknown[]) => void logged.push(args);

    try {
      const s = await connectAs('ord-grace');
      const a = command(s, 'ord.hang');
      const b = command(s, 'ord.conn', { tag: 'B', ms: 0 });

      expect(errorOf(await a).code).to.equal('deadline_exceeded');
      expect(resultOf(await b)).to.equal('B');
      expect(ordDone).to.deep.equal(['B']);
      expect(logged).to.have.length(1);
      const text = logged[0].map(String).join(' ');
      expect(text).to.contain('connection:').and.to.contain('ord.hang');
    } finally {
      stage.Log.error = original;
    }
  });

  it("keeps ordered: 'client' order across a reconnect after a disconnect abort", async () => {
    const first = await connectAs('ord-rc');
    void command(first, 'ord.gate').catch(() => undefined);
    await delay(100);
    first.close();
    await delay(100);

    const second = await connectAs('ord-rc');
    const b = command(second, 'ord.client', { tag: 'B', ms: 0 });
    await delay(200);
    expect(ordDone).to.deep.equal([]);

    gate.open();
    expect(resultOf(await b)).to.equal('B');
    expect(ordDone).to.deep.equal(['gate', 'B']);
  });

  it('drops the queue of a client once its commands are done', async () => {
    const stage = await orderingStage();
    const s = await connectAs('ord-clean');
    const a = command(s, 'ord.gate');
    await delay(100);
    expect(stage.Queue.Size).to.be.greaterThan(0);

    gate.open();
    await a;
    await delay(50);
    expect(stage.Queue.Size).to.equal(0);
  });

  it('refuses a non-positive abort grace at startup', () => {
    for (const bad of [0, -1, Number.NaN]) {
      expect(() => assertOrderingConfig({ ordering: { abortGraceMs: bad } })).to.throw(RangeError);
    }
    expect(() => assertOrderingConfig({ ordering: { abortGraceMs: 1 } })).not.to.throw();
  });
});
