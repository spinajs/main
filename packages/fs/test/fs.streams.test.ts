import 'mocha';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { InvalidArgument, InvalidOperation, LimitExceeded } from '@spinajs/exceptions';

import { ByteLimitStream, DigestStream } from '../src/index.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

function sink(): { chunks: Buffer[]; stream: Writable; text(): string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  return { chunks, stream, text: () => Buffer.concat(chunks).toString('utf-8') };
}

const sha = (algorithm: string, data: string, encoding: 'hex' | 'base64' = 'hex') => createHash(algorithm).update(data).digest(encoding);

describe('fs streams', () => {
  describe('DigestStream', () => {
    it('passes the input on unchanged and digests all of it', async () => {
      const digest = new DigestStream();
      const out = sink();

      await pipeline(Readable.from([Buffer.from('hello '), 'wor', Buffer.from('ld')]), digest, out.stream);

      expect(out.text()).to.equal('hello world');
      expect(digest.bytes).to.equal(11);
      expect(digest.digest()).to.equal(sha('sha256', 'hello world'));
      expect(digest.digest('hex')).to.equal(sha('sha256', 'hello world'));
      expect(digest.digest('base64')).to.equal(sha('sha256', 'hello world', 'base64'));
    });

    it('uses the algorithm it was given', async () => {
      const digest = new DigestStream('sha512');
      await pipeline(Readable.from(['abc']), digest, sink().stream);
      expect(digest.digest()).to.equal(sha('sha512', 'abc'));
    });

    it('digests an empty input', async () => {
      const digest = new DigestStream();
      await pipeline(Readable.from([]), digest, sink().stream);
      expect(digest.bytes).to.equal(0);
      expect(digest.digest()).to.equal(sha('sha256', ''));
    });

    it('refuses the digest before the stream finished, and gives it from finish on', async () => {
      const digest = new DigestStream();
      digest.resume();
      digest.write('ab');
      expect(digest.bytes).to.equal(2);
      expect(() => digest.digest()).to.throw(InvalidOperation);

      const atFinish = new Promise<string>((resolve) => digest.on('finish', () => resolve(digest.digest())));
      digest.end('c');
      expect(await atFinish).to.equal(sha('sha256', 'abc'));
    });
  });

  describe('ByteLimitStream', () => {
    it('passes exactly maxBytes', async () => {
      const limit = new ByteLimitStream(5);
      const out = sink();

      await pipeline(Readable.from([Buffer.from('abc'), Buffer.from('de')]), limit, out.stream);

      expect(out.text()).to.equal('abcde');
      expect(limit.bytes).to.equal(5);
    });

    it('fails with LimitExceeded on byte maxBytes + 1', async () => {
      const limit = new ByteLimitStream(5);
      const out = sink();

      await expect(pipeline(Readable.from([Buffer.from('abcdef')]), limit, out.stream)).to.be.rejectedWith(LimitExceeded);

      expect(out.chunks).to.deep.equal([]);
      expect(limit.bytes).to.equal(0);
    });

    it('drops the chunk that goes over and keeps what passed before it', async () => {
      const limit = new ByteLimitStream(5);
      const out = sink();

      await expect(pipeline(Readable.from([Buffer.from('abc'), Buffer.from('def')]), limit, out.stream)).to.be.rejectedWith(LimitExceeded);

      expect(out.text()).to.equal('abc');
      expect(limit.bytes).to.equal(3);
    });

    it('with maxBytes 0 passes an empty input and fails on the first byte', async () => {
      await pipeline(Readable.from([]), new ByteLimitStream(0), sink().stream);
      await expect(pipeline(Readable.from([Buffer.from('a')]), new ByteLimitStream(0), sink().stream)).to.be.rejectedWith(LimitExceeded);
    });

    it('fails the whole pipeline in front of a DigestStream, which then has no digest', async () => {
      const digest = new DigestStream();

      await expect(pipeline(Readable.from([Buffer.from('abcdef')]), new ByteLimitStream(4), digest, sink().stream)).to.be.rejectedWith(LimitExceeded);

      expect(() => digest.digest()).to.throw(InvalidOperation);
    });

    it('refuses a maxBytes that is not a non-negative integer', () => {
      for (const max of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => new ByteLimitStream(max), String(max)).to.throw(InvalidArgument);
      }
    });
  });
});
