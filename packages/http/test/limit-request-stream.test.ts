import 'mocha';
import { expect } from 'chai';
import { PassThrough, type Readable } from 'node:stream';
import { IOFail, LimitExceeded } from '@spinajs/exceptions';

import { limitRequestStream } from '../src/index.js';

const EVENTS = ['error', 'close', 'end', 'data'] as const;
const listeners = (stream: Readable) => EVENTS.map((event) => stream.listenerCount(event));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
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
    expect(failure).to.eq(null);
    expect(request.readableFlowing).to.eq(true);

    request.end(Buffer.from('rest of the body'));
    await reading;
    expect(failure).to.be.instanceOf(LimitExceeded);
    await nextTurn();
    expect(listeners(request)).to.deep.eq(before);
  });

  it('fails with the request error when the request fails', async () => {
    const request = new PassThrough();
    const body = limitRequestStream(request, 100);
    const reading = readAll(body).catch((err: unknown) => err);
    const aborted = new Error('aborted');

    request.destroy(aborted);

    expect(await reading).to.eq(aborted);
  });

  it('fails with IOFail when the request closes before its body ended', async () => {
    const request = new PassThrough();
    const body = limitRequestStream(request, 100);
    const reading = readAll(body).catch((err: unknown) => err);

    request.destroy();

    expect(await reading).to.be.instanceOf(IOFail);
  });

  it('reads off the rest of the body and removes its listeners when the consumer gives up', async () => {
    const request = new PassThrough();
    const before = listeners(request);
    const body = limitRequestStream(request, 100);
    request.write(Buffer.from('ab'));

    body.destroy();
    await nextTurn();

    expect(request.readableFlowing).to.eq(true);
    expect(listeners(request)).to.deep.eq(before);
  });
});
