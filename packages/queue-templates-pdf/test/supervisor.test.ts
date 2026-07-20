import { EventEmitter } from 'events';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { RenderPdfJob } from '../src/RenderPdfJob.js';

const expect = chai.expect;
chai.use(chaiAsPromised);

/** Stand-in for a forked ChildProcess: records sends/kills, emits messages on demand. */
class FakeChild extends EventEmitter {
  public sent: any[] = [];
  public killed = false;

  public send(msg: any): boolean {
    this.sent.push(msg);
    return true;
  }

  public kill(_signal?: any): boolean {
    this.killed = true;
    return true;
  }
}

/** RenderPdfJob wired to a fake child so the supervision logic is tested without forking. */
class TestJob extends RenderPdfJob {
  public child = new FakeChild();

  protected spawnWorker(): any {
    return this.child;
  }
}

function makeJob(): TestJob {
  const job = new TestJob();
  job.input = '<h1>hello</h1>';
  job.output = { provider: 'out', path: 'x.pdf' };
  job.pdfOptions = { format: 'A4' };
  return job;
}

const noopProgress = () => Promise.resolve();

describe('RenderPdfJob (supervisor)', () => {
  it('sends the render request to the worker on execute', () => {
    const job = makeJob();
    void job.execute(noopProgress);

    expect(job.child.sent).to.have.length(1);
    expect(job.child.sent[0]).to.include({ input: '<h1>hello</h1>' });
    expect(job.child.sent[0].output).to.deep.eq({ provider: 'out', path: 'x.pdf' });
    expect(job.child.sent[0].pdfOptions).to.deep.eq({ format: 'A4' });
  });

  it('relays progress (percent + phase + message) and resolves on done', async () => {
    const job = makeJob();
    const calls: Array<{ p: number; meta: any }> = [];

    const promise = job.execute((p, meta) => {
      calls.push({ p, meta });
      return Promise.resolve();
    });

    job.child.emit('message', { type: 'progress', percent: 40, phase: 'loading', message: 'm' });
    job.child.emit('message', { type: 'done', result: { provider: 'out', path: 'x.pdf' } });

    const result = await promise;
    expect(result).to.deep.eq({ provider: 'out', path: 'x.pdf' });
    expect(calls).to.deep.eq([{ p: 40, meta: { phase: 'loading', message: 'm' } }]);
  });

  it('rejects and kills the worker on an error message', async () => {
    const job = makeJob();
    const promise = job.execute(noopProgress);

    job.child.emit('message', { type: 'error', message: 'boom' });

    await expect(promise).to.be.rejectedWith('boom');
    expect(job.child.killed).to.eq(true);
  });

  it('rejects on an unexpected worker exit', async () => {
    const job = makeJob();
    const promise = job.execute(noopProgress);

    job.child.emit('exit', 1);

    await expect(promise).to.be.rejectedWith(/exited unexpectedly with code 1/);
  });

  it('force-kills the worker and rejects on timeout', async () => {
    const job = makeJob();
    job.timeoutMs = 30;

    const promise = job.execute(noopProgress);
    // no messages -> watchdog fires

    await expect(promise).to.be.rejectedWith(/timed out/);
    expect(job.child.killed).to.eq(true);
  });

  it('ignores messages after settling (done then stray exit)', async () => {
    const job = makeJob();
    const promise = job.execute(noopProgress);

    job.child.emit('message', { type: 'done', result: { provider: 'out', path: 'x.pdf' } });
    // a late exit must not turn a success into a rejection
    job.child.emit('exit', 0);

    await expect(promise).to.eventually.deep.eq({ provider: 'out', path: 'x.pdf' });
  });
});
