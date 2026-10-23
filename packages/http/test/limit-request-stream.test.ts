import 'mocha';
import { expect } from 'chai';
import { PassThrough, type Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { IOFail, LimitExceeded } from '@spinajs/exceptions';

import { limitRequestStream } from '../src/index.js';

const EVENTS = ['error', 'close', 'end', 'data'] as const;
const listeners = (stream: Readable) => EVENTS.map((event) => stream.listenerCount(event));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const PENDING = Symbol('pending');
const settled = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), 50))]);

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Mocha's own handler would only report an uncaught error on some later test; this pins it to the one that caused it.
async function expectNothingUncaught(run: () => Promise<void>): Promise<void> {
  const uncaught: unknown[] = [];
  const record = (err: unknown) => uncaught.push(err);
  process.on('uncaughtException', record);
  try {
    await run();
    await nextTurn();
  } finally {
    process.off('uncaughtException', record);
  }
  expect(uncaught).to.deep.eq([]);
}

// A PassThrough stands in for the IncomingMessage: both are Readables that end, error and close the same way.
describe('limitRequestStream', () => {
  it('passes a body of exactly maxBytes and removes its listeners from the request', async () => {
    const request = new PassThrough();
    const before = listeners(request);

    const body = limitRequestStream(request, 4);
    request.end(Buffer.from('abcd'));

    expect((await readAll(body)).toString()).to.eq('abcd');
    await nextTurn();
    expect(listeners(request)).to.deep.eq(before);
  });

  it('raises LimitExceeded only after the request ended, and reads off the rest of the body meanwhile', async () => {
    const request = new PassThrough();
    const before = listeners(request);
    const body = limitRequestStream(request, 4);
    let failure: unknown = null;
    const reading = readAll(body).catch((err: unknown) => (failure = err));

    request.write(Buffer.from('abcde'));
    await nextTurn();
    await nextTurn();
    request.write(Buffer.from('more past the limit'));
    await nextTurn();
    expect(failure).to.eq(null);
    expect(request.readableFlowing).to.eq(true);
    expect(request.readableLength).to.eq(0);

    request.end(Buffer.from('rest of the body'));
    await reading;
    expect(failure).to.be.instanceOf(LimitExceeded);
    await nextTurn();
    expect(listeners(request)).to.deep.eq(before);
  });

  it('fails with the request error when the request fails', async () => {
    const request = new PassThrough();
    const before = listeners(request);
    const body = limitRequestStream(request, 100);
    const reading = readAll(body).catch((err: unknown) => err);
    const aborted = new Error('aborted');

    request.destroy(aborted);

    expect(await reading).to.eq(aborted);
    await nextTurn();
    expect(listeners(request)).to.deep.eq(before);
  });

  it('fails with IOFail when the request closes before its body ended', async () => {
    const request = new PassThrough();
    const before = listeners(request);
    const body = limitRequestStream(request, 100);
    const reading = readAll(body).catch((err: unknown) => err);

    request.destroy();

    expect(await reading).to.be.instanceOf(IOFail);
    await nextTurn();
    expect(listeners(request)).to.deep.eq(before);
  });

  it('fails with IOFail and adds no listeners when the request closed before the call', async () => {
    const request = new PassThrough();
    request.destroy();
    await nextTurn();
    const before = listeners(request);

    const body = limitRequestStream(request, 100);

    expect(await settled(readAll(body).catch((err: unknown) => err))).to.be.instanceOf(IOFail);
    expect(listeners(request)).to.deep.eq(before);
  });

  it('fails with the request error and adds no listeners when the request failed before the call', async () => {
    const request = new PassThrough();
    const aborted = new Error('aborted');
    request.on('error', () => undefined);
    request.destroy(aborted);
    await nextTurn();
    const before = listeners(request);

    const body = limitRequestStream(request, 100);

    expect(await settled(readAll(body).catch((err: unknown) => err))).to.eq(aborted);
    expect(listeners(request)).to.deep.eq(before);
  });

  it('reads off the rest of the body and removes its listeners when the consumer gives up', async () => {
    const request = new PassThrough();
    const before = listeners(request);
    const body = limitRequestStream(request, 100);
    request.write(Buffer.from('ab'));

    body.destroy();
    await nextTurn();
    request.write(Buffer.from('more of the body'));
    await nextTurn();

    expect(request.readableFlowing).to.eq(true);
    expect(request.readableLength).to.eq(0);
    request.end();
    await nextTurn();
    expect(listeners(request)).to.deep.eq(before);
  });

  it('does not throw when the request fails after the consumer gave up', async () => {
    const request = new PassThrough();
    const before = listeners(request);
    const body = limitRequestStream(request, 100);
    request.write(Buffer.from('ab'));

    body.destroy();
    await nextTurn();
    request.destroy(new Error('aborted'));
    await nextTurn();

    expect(listeners(request)).to.deep.eq(before);
  });

  it('does not throw when the limit is passed in the turn the consumer gives up', async () => {
    const request = new PassThrough();
    const body = limitRequestStream(request, 4);
    let failure: unknown = null;
    body.on('error', (err: unknown) => (failure = err));

    request.write(Buffer.from('abcde'));
    body.destroy();
    await nextTurn();
    await nextTurn();
    request.end();
    await nextTurn();

    expect(failure).to.eq(null);
    expect(request.readableLength).to.eq(0);
  });

  describe('when the stream fails before anything reads it', () => {
    it('keeps a request closed before the call for a later reader', () =>
      expectNothingUncaught(async () => {
        const request = new PassThrough();
        request.destroy();
        await nextTurn();

        const body = limitRequestStream(request, 100);
        await sleep(10);

        expect(await settled(readAll(body).catch((err: unknown) => err))).to.be.instanceOf(IOFail);
      }));

    it('keeps the error of a request failed before the call for a later reader', () =>
      expectNothingUncaught(async () => {
        const request = new PassThrough();
        const aborted = new Error('aborted');
        request.on('error', () => undefined);
        request.destroy(aborted);
        await nextTurn();

        const body = limitRequestStream(request, 100);
        await sleep(10);

        expect(await settled(readAll(body).catch((err: unknown) => err))).to.eq(aborted);
      }));

    it('keeps the request error for a later reader', () =>
      expectNothingUncaught(async () => {
        const request = new PassThrough();
        const body = limitRequestStream(request, 100);
        const aborted = new Error('aborted');
        request.write(Buffer.from('ab'));
        await nextTurn();

        request.destroy(aborted);
        await sleep(10);

        expect(await settled(readAll(body).catch((err: unknown) => err))).to.eq(aborted);
      }));

    it('keeps the IOFail of a request closed mid-body for a later reader', () =>
      expectNothingUncaught(async () => {
        const request = new PassThrough();
        const body = limitRequestStream(request, 100);
        request.write(Buffer.from('ab'));
        await nextTurn();

        request.destroy();
        await sleep(10);

        expect(await settled(readAll(body).catch((err: unknown) => err))).to.be.instanceOf(IOFail);
      }));

    it('keeps LimitExceeded for a later reader', () =>
      expectNothingUncaught(async () => {
        const request = new PassThrough();
        const body = limitRequestStream(request, 1024);

        request.end(Buffer.alloc(4096));
        await sleep(10);

        expect(await settled(readAll(body).catch((err: unknown) => err))).to.be.instanceOf(LimitExceeded);
      }));

    it('rejects a later pipeline with the error', () =>
      expectNothingUncaught(async () => {
        const request = new PassThrough();
        const body = limitRequestStream(request, 100);
        const aborted = new Error('aborted');

        request.destroy(aborted);
        await sleep(10);

        const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
        expect(await settled(pipeline(body, sink).catch((err: unknown) => err))).to.eq(aborted);
      }));
  });
});
