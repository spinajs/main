import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import 'mocha';
import { RowQueue } from '../src/row-queue.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

class FakeSource {
  public pauses = 0;
  public resumes = 0;

  public pause(): void {
    this.pauses++;
  }

  public resume(): void {
    this.resumes++;
  }
}

async function readAll(queue: RowQueue): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const row of queue.read()) {
    out.push(row);
  }
  return out;
}

describe('RowQueue', () => {
  it('yields the pushed rows in order, then ends', async () => {
    const queue = new RowQueue(new FakeSource(), 10);
    queue.push(1);
    queue.push(2);
    setImmediate(() => {
      queue.push(3);
      queue.end();
    });

    expect(await readAll(queue)).to.deep.equal([1, 2, 3]);
  });

  it('pauses the source at the high water mark and resumes it once the buffer is empty', async () => {
    const source = new FakeSource();
    const queue = new RowQueue(source, 2);
    queue.push('a');
    queue.push('b');
    queue.push('c');
    expect(source.pauses).to.eq(1);

    const rows = queue.read();
    await rows.next();
    await rows.next();
    expect(source.resumes).to.eq(0);
    await rows.next();
    expect(source.resumes).to.eq(1);

    queue.end();
    expect((await rows.next()).done).to.eq(true);
  });

  it('yields what arrived before a failure, then throws it', async () => {
    const queue = new RowQueue(new FakeSource(), 10);
    queue.push(1);
    queue.fail(new Error('connection reset'));
    const seen: unknown[] = [];

    const loop = async () => {
      for await (const row of queue.read()) {
        seen.push(row);
      }
    };

    await expect(loop()).to.be.rejectedWith('connection reset');
    expect(seen).to.deep.equal([1]);
  });

  it('discard drops the buffer, resumes a paused source and waits for its end', async () => {
    const source = new FakeSource();
    const queue = new RowQueue(source, 1);
    queue.push(1);
    let settled = false;

    const discarded = (async () => {
      await queue.discard();
      settled = true;
    })();
    expect(source.resumes).to.eq(1);

    queue.push(2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).to.eq(false);

    queue.end();
    await discarded;
    expect(settled).to.eq(true);
  });

  it('wakes a reader that waits after a resume when the source ends', async () => {
    const source = new FakeSource();
    const queue = new RowQueue(source, 1);
    queue.push(1);
    const rows = queue.read();
    expect((await rows.next()).value).to.eq(1);
    expect(source.resumes).to.eq(1);

    const waiting = rows.next();
    queue.end();
    expect((await waiting).done).to.eq(true);
  });

  it('pauses and resumes the source once per drained batch, over many batches', async () => {
    const source = new FakeSource();
    const queue = new RowQueue(source, 3);
    const reading = readAll(queue);
    for (let batch = 0; batch < 50; batch++) {
      queue.push(batch * 3);
      queue.push(batch * 3 + 1);
      queue.push(batch * 3 + 2);
      await new Promise((resolve) => setImmediate(resolve));
    }
    queue.end();

    expect(await reading).to.deep.equal(Array.from({ length: 150 }, (_, i) => i));
    expect([source.pauses, source.resumes]).to.deep.equal([50, 50]);
  });

  it('is finished only once the source ended without a failure', () => {
    const ended = new RowQueue(new FakeSource(), 1);
    ended.end();
    const failed = new RowQueue(new FakeSource(), 1);
    failed.fail(new Error('connection reset'));

    expect([ended.finished, failed.finished, new RowQueue(new FakeSource(), 1).finished]).to.deep.equal([true, false, false]);
  });
});
