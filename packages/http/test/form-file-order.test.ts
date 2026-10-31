import 'mocha';
import { expect } from 'chai';
import { PassThrough, Writable } from 'node:stream';
import type { Request } from 'express';
import { parseForm } from '../src/route-args/FromForm.js';

const BOUNDARY = 'spinajsboundary';

function part(name: string, filename: string, body: string) {
  return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`;
}

function multipartRequest(body: string) {
  const req = new PassThrough();
  Object.assign(req, { headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': String(Buffer.byteLength(body)) } });
  req.end(body);
  return req as unknown as Request;
}

const storedLast = (slow: string) => (file?: { originalFilename?: string | null }) =>
  new Writable({
    write: (_chunk, _encoding, done) => done(),
    final: (done) => setTimeout(done, file?.originalFilename === slow ? 50 : 0),
  });

describe('parseForm', () => {
  it('hands over repeated files in the order they were sent, not the order they finished storing', async () => {
    const req = multipartRequest(`${part('photos', 'a.png', 'a')}${part('photos', 'b.png', 'b')}--${BOUNDARY}--\r\n`);

    const { Files } = await parseForm(req, { multiples: true, fileWriteStreamHandler: storedLast('a.png') });

    expect((Files.photos as unknown as { originalFilename: string }[]).map((f) => f.originalFilename)).to.deep.equal(['a.png', 'b.png']);
  });
});
