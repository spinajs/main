import 'mocha';
import { expect } from 'chai';

import type { UploadErrorBody } from '../../src/http/index.js';
import type { UploadStateView } from '../../src/index.js';
import { resetUploads, rows } from '../support/env.js';
import { text } from '../support/flow.js';
import { Seen } from './support/calls.js';
import { appPort, uploadApp } from './support/app.js';
import { BASE, bodyOf, createUpload, digestOf, partOf, sendPart } from './support/client.js';
import { rawRequest, wait } from './support/raw.js';

describe('UploadController over HTTP: the unread body of a refused part', function () {
  this.timeout(30000);

  const file = text(10);
  const MISSING = '00000000-0000-4000-8000-000000000000';
  let id: string;

  const raw = (path: string, headers: Record<string, string | number>) => rawRequest(appPort(), 'PUT', path, { 'content-type': 'application/octet-stream', 'x-test-owner': 'alice', ...headers });
  const codeOf = (body: string): string => (JSON.parse(body) as UploadErrorBody).code;

  before(uploadApp);
  beforeEach(async () => {
    await resetUploads();
    Seen.reset();
    id = bodyOf<UploadStateView>(await createUpload(file)).id;
  });

  it('holds a preflight refusal until a body within the part size has arrived, and keeps the connection', async () => {
    const exchange = raw(`${BASE}/${id}/parts/1`, { 'content-length': 4 });
    exchange.write(Buffer.from('ab'));
    await wait(300);
    expect(exchange.answered(), 'answered while the client was still sending').to.eq(false);

    exchange.end(Buffer.from('cd'));
    const res = await exchange.response;
    expect([res.status, codeOf(res.body), res.headers.connection]).to.deep.equal([400, 'upload.digest_required', 'keep-alive']);
  });

  // The raw clients of the next two keep their body in flight: a body that has arrived whole keeps the connection.
  it('refuses a body longer than the part with Connection: close, and the client still reads the JSON', async () => {
    const long = Buffer.alloc(10, 97);
    const viaChai = await sendPart(id, 1, long);
    expect([viaChai.status, bodyOf<UploadErrorBody>(viaChai).code]).to.deep.equal([400, 'upload.part_size']);

    const exchange = raw(`${BASE}/${id}/parts/1`, { 'content-length': 10, 'content-digest': digestOf(long) });
    exchange.write(long.subarray(0, 2));
    const res = await exchange.response;
    expect([res.status, codeOf(res.body), res.headers.connection]).to.deep.equal([400, 'upload.part_size', 'close']);
  });

  it('refuses a body without Content-Length with 411 and Connection: close', async () => {
    const exchange = raw(`${BASE}/${id}/parts/1`, { 'transfer-encoding': 'chunked', 'content-digest': digestOf(partOf(file, 1)) });
    exchange.write(partOf(file, 1));

    const res = await exchange.response;
    expect([res.status, codeOf(res.body), res.headers.connection]).to.deep.equal([411, 'upload.length_required', 'close']);
    expect(await rows('upload_parts', { session_id: id })).to.deep.equal([]);
  });

  it('drains the body of a part for a session that does not exist, then answers 404', async () => {
    const exchange = raw(`${BASE}/${MISSING}/parts/1`, { 'content-length': 4, 'content-digest': digestOf(partOf(file, 1)) });
    exchange.write(Buffer.from('ab'));
    await wait(300);
    expect(exchange.answered()).to.eq(false);

    exchange.end(Buffer.from('cd'));
    const res = await exchange.response;
    expect([res.status, codeOf(res.body), res.headers.connection]).to.deep.equal([404, 'upload.not_found', 'keep-alive']);
  });

  it('drains the body when the class policy refuses before the action', async () => {
    const exchange = raw(`${BASE}/${id}/parts/1`, { 'content-length': 4, 'content-digest': digestOf(partOf(file, 1)), 'x-test-policy': 'deny' });
    exchange.write(Buffer.from('ab'));
    await wait(300);
    expect(exchange.answered()).to.eq(false);

    exchange.end(Buffer.from('cd'));
    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([403, 'keep-alive']);
    expect(Seen.authorized.map((a) => a.action)).to.deep.equal(['create']);
  });

  it('drains the body when the route args refuse a malformed Content-Digest', async () => {
    const exchange = raw(`${BASE}/${id}/parts/1`, { 'content-length': 4, 'content-digest': 'sha-256=not-a-byte-sequence' });
    exchange.end(partOf(file, 1));

    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([400, 'keep-alive']);
  });

  it('answers a refusal after the body was read without closing the connection', async () => {
    const exchange = raw(`${BASE}/${id}/parts/1`, { 'content-length': 4, 'content-digest': digestOf(partOf(file, 2)) });
    exchange.end(partOf(file, 1));

    const res = await exchange.response;
    expect([res.status, codeOf(res.body), res.headers.connection]).to.deep.equal([400, 'upload.part_digest_mismatch', 'keep-alive']);
  });

  it('keeps the connection of every bodiless refusal', async () => {
    const bodiless = async (method: string, path: string) => {
      const exchange = rawRequest(appPort(), method, path, { accept: 'application/json', 'x-test-owner': 'alice' });
      exchange.end();
      const res = await exchange.response;
      return [res.status, res.headers.connection];
    };

    expect(await bodiless('GET', `${BASE}/${MISSING}`)).to.deep.equal([404, 'keep-alive']);
    expect(await bodiless('HEAD', `${BASE}/${MISSING}`)).to.deep.equal([404, 'keep-alive']);
    expect(await bodiless('DELETE', `${BASE}/${MISSING}`)).to.deep.equal([404, 'keep-alive']);
  });
});
