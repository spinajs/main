import 'mocha';
import { expect } from 'chai';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DI } from '@spinajs/di';
import { Intl } from '@spinajs/intl';

import { httpApp, req } from './common.js';
import { BaseController, BasePath, ContentDigest, ContentDigestArg, Controllers, HttpServer, Ok, Post, RequestStream } from '../src/index.js';
import type { TestApp } from '@spinajs/testing';

const hex = (digests: Map<string, Buffer>) => Object.fromEntries([...digests].map(([algorithm, digest]) => [algorithm, digest.toString('hex')]));

@BasePath('content-digest')
class ContentDigestController extends BaseController {
  @Post()
  public optional(@ContentDigest() digests: Map<string, Buffer>) {
    return new Ok(hex(digests));
  }

  @Post()
  public required(@ContentDigest({ required: true }) digests: Map<string, Buffer>) {
    return new Ok(hex(digests));
  }

  @Post()
  public sha256(@ContentDigest({ algorithms: ['SHA-256'] }) digests: Map<string, Buffer>) {
    return new Ok(hex(digests));
  }

  @Post()
  public async verified(@RequestStream({ maxBytes: 1024 * 1024 }) body: Readable, @ContentDigest({ required: true, algorithms: ['sha-256'] }) digests: Map<string, Buffer>) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of body) {
      bytes += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
    }
    return new Ok({ bytes, matches: hash.digest().equals(digests.get('sha-256')!) });
  }
}

const digestOf = (algorithm: 'sha256' | 'sha512', data: string | Buffer) => createHash(algorithm).update(data).digest();
const SHA256 = digestOf('sha256', 'x');
const SHA512 = digestOf('sha512', 'x');
const BOTH = `sha-256=:${SHA256.toString('base64')}:, sha-512=:${SHA512.toString('base64')}:`;

describe('@ContentDigest', function () {
  this.timeout(15000);

  let app: TestApp;

  before(async () => {
    app = await httpApp({
      register: (c) => c.register(ContentDigestController).as(BaseController),
      resolve: [Intl, Controllers],
    });
    await (await app.resolve(HttpServer)).start();
  });

  after(async () => {
    await app.dispose();
  });

  it('is resolvable from DI by its parameter type name', async () => {
    expect(await DI.resolve('ContentDigestArg')).to.be.instanceOf(ContentDigestArg);
  });

  it('gives every digest of the header, keyed by algorithm', async () => {
    const res = await req().post('content-digest/optional').set('Content-Digest', BOTH);
    expect(res).to.have.status(200);
    expect(res.body).to.deep.eq({ 'sha-256': SHA256.toString('hex'), 'sha-512': SHA512.toString('hex') });
  });

  it('gives an empty map when the header is absent and not required', async () => {
    const res = await req().post('content-digest/optional');
    expect(res).to.have.status(200);
    expect(res.body).to.deep.eq({});
  });

  it('answers 400 when a required header is absent', async () => {
    expect(await req().post('content-digest/required')).to.have.status(400);
  });

  it('answers 400 when a required header is empty', async () => {
    expect(await req().post('content-digest/required').set('Content-Digest', ' ')).to.have.status(400);
  });

  it('answers 400 for a malformed header', async () => {
    expect(await req().post('content-digest/optional').set('Content-Digest', 'sha-256=:not base64:')).to.have.status(400);
  });

  it('keeps only the accepted algorithms', async () => {
    const res = await req().post('content-digest/sha256').set('Content-Digest', BOTH);
    expect(res).to.have.status(200);
    expect(res.body).to.deep.eq({ 'sha-256': SHA256.toString('hex') });
  });

  it('answers 400 when the header carries none of the accepted algorithms', async () => {
    const res = await req().post('content-digest/sha256').set('Content-Digest', `sha-512=:${SHA512.toString('base64')}:`);
    expect(res).to.have.status(400);
  });

  it('checks a raw body against its digest end to end', async () => {
    const payload = randomBytes(200 * 1024);
    const res = await req()
      .post('content-digest/verified')
      .set('content-type', 'application/octet-stream')
      .set('content-digest', `sha-256=:${digestOf('sha256', payload).toString('base64')}:`)
      .send(payload);
    expect(res).to.have.status(200);
    expect(res.body).to.deep.eq({ bytes: payload.length, matches: true });
  });
});
