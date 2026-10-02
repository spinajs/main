import 'mocha';
import { expect } from 'chai';
import { Socket as ClientSocket } from 'socket.io-client';
import { BaseSocketController } from '../src/controller.js';
import { Command, Payload, SocketController } from '../src/decorators.js';
import { SerialQueue } from '../src/queue.js';
import { DI } from '@spinajs/di';
import { SocketCommandStage } from '../src/interfaces.js';
import { ITestServer, command, delay, errorOf, open, resultOf, startServer } from './harness.js';

export const ordDone: string[] = [];

interface IOrdStep {
  tag: string;
  ms: number;
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
    await delay(300);
    ordDone.push('hang');
    return 'hang';
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

  const connectAs = async (clientId: string) => {
    const socket = await open(t, { auth: { clientId } });
    sockets.push(socket);
    return socket;
  };

  beforeEach(async () => {
    ordDone.length = 0;
    t = await startServer();
  });

  afterEach(async () => {
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

  it('skips a queued command whose deadline passed while it waited', async () => {
    const s = await connectAs('ord-late');
    const a = command(s, 'ord.conn', { tag: 'A', ms: 150 });
    const b = command(s, 'ord.conn', { tag: 'B', ms: 0 }, { deadline: 50 });

    expect(errorOf(await b).code).to.equal('deadline_exceeded');
    expect(resultOf(await a)).to.equal('A');
    await delay(50);
    expect(ordDone).to.deep.equal(['A']);
  });

  it('releases the queue when a running command is aborted by its deadline', async () => {
    const s = await connectAs('ord-abort');
    const a = command(s, 'ord.hang');
    const b = command(s, 'ord.conn', { tag: 'B', ms: 0 });

    expect(errorOf(await a).code).to.equal('deadline_exceeded');
    expect(resultOf(await b)).to.equal('B');
    expect(ordDone).to.deep.equal(['B']);
  });

  it('drops the queue of a client once its commands are done', async () => {
    const s = await connectAs('ord-clean');
    await command(s, 'ord.client', { tag: 'A', ms: 0 });
    s.close();
    await delay(50);
    const stages = (await DI.resolve(Array.ofType(SocketCommandStage))) as SocketCommandStage[];
    const stage = stages.find((x) => x.constructor.name === 'OrderingStage') as unknown as { Queue: SerialQueue };
    expect(stage.Queue.Size).to.equal(0);
  });
});
