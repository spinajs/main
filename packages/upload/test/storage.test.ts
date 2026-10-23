import 'mocha';
import { expect } from 'chai';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidArgument, ResourceDuplicated } from '@spinajs/exceptions';
import { getFs } from '@spinajs/fs';
import { LogLevel } from '@spinajs/log';
import { DateTime } from 'luxon';
import sinon from 'sinon';

import { UploadStorage, assertFsProviders } from '../src/index.js';
import type { UploadPart, UploadSession } from '../src/index.js';
import { HeadCapture } from '../src/streams.js';
import { uploadLogs } from './support/capture.js';
import { insertSessionRow, objectsOf, pathIn, resetUploads, rows, uploadEnv } from './support/env.js';
import { bodyOf, rejection, sha256hex, text, uploadErrorOf } from './support/flow.js';
import { StrictFs } from './support/strict-fs.js';

describe('UploadStorage', () => {
  let storage: UploadStorage;

  const sessionOf = async (values: Record<string, unknown> = {}) => (await uploadEnv()).store.requireSession(await insertSessionRow(values));

  /** Writes and commits the parts as putPart would, without the service. */
  async function storeParts(session: UploadSession, chunks: Buffer[]): Promise<UploadPart[]> {
    const { store } = await uploadEnv();
    for (const [i, chunk] of chunks.entries()) {
      const written = await storage.writePart(session, i + 1, bodyOf(chunk), chunk.length, sha256hex(chunk));
      await store.upsertPart({ session_id: session.id, number: i + 1, size: written.size, sha256: written.sha256, storage_key: written.key, detected_mime: null, received_at: DateTime.utc() });
      expect(await store.setBlobState(written.blobId, 'writing', 'live', DateTime.utc())).to.eq(true);
    }
    return store.listParts(session.id);
  }

  before(async () => {
    await uploadEnv();
    storage = await DI.resolve(UploadStorage);
  });
  beforeEach(resetUploads);
  afterEach(() => {
    sinon.restore();
    expect(StrictFs.Banned).to.deep.equal([]);
  });

  it('HeadCapture passes every byte on and keeps the first N', async () => {
    const head = new HeadCapture(5);
    const out: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        out.push(chunk);
        done();
      },
    });
    await pipeline(Readable.from([Buffer.from('abc'), Buffer.from('defgh')], { objectMode: false }), head, sink);
    expect(Buffer.concat(out).toString()).to.eq('abcdefgh');
    expect(head.head.toString()).to.eq('abcde');
  });

  it('writes each part to its own key, with the blob row inserted before the write', async () => {
    const { store } = await uploadEnv();
    const s = await sessionOf();
    const insert = sinon.spy(store, 'insertBlob');
    const write = sinon.spy(getFs('upload-temp'), 'writeStream');

    const a = await storage.writePart(s, 1, bodyOf(Buffer.from('abcd')), 4, sha256hex(Buffer.from('abcd')));
    const b = await storage.writePart(s, 1, bodyOf(Buffer.from('abcd')), 4, undefined);

    expect(a.key).to.match(new RegExp(`^uploads/${s.id}/00001-[0-9a-f-]{36}$`));
    expect(b.key).to.not.eq(a.key);
    expect([a.size, a.sha256, a.head.toString()]).to.deep.equal([4, sha256hex(Buffer.from('abcd')), 'abcd']);
    expect(readFileSync(pathIn('temp', a.key)).toString()).to.eq('abcd');
    expect(insert.firstCall.args[0]).to.include({ session_id: s.id, fs: 'upload-temp', key: a.key, kind: 'part' });
    expect(insert.firstCall.calledBefore(write.firstCall)).to.eq(true);
    expect(write.firstCall.args[1]).to.deep.equal({ exclusive: true, metadata: { hash: sha256hex(Buffer.from('abcd')) } });
    expect(write.secondCall.args[1]).to.deep.equal({ exclusive: true });
    expect((await rows('upload_blobs', { key: a.key }))[0].state).to.eq('writing');
  });

  it('writes nested keys on both providers without a mkdir call', async () => {
    const file = text(10);
    const s = await sessionOf();
    const mkdirs = [sinon.spy(getFs('upload-temp'), 'mkdir'), sinon.spy(getFs('upload-files'), 'mkdir')];

    const parts = await storeParts(s, [file.subarray(0, 4), file.subarray(4, 8), file.subarray(8)]);
    const assembled = await storage.assemble(s, parts, { dir: 'uploads/files/2026/10', contentType: 'text/plain', declaredSha256: null });

    expect(readFileSync(pathIn('temp', parts[0].storage_key)).length).to.eq(4);
    expect(readFileSync(pathIn('files', assembled.key))).to.deep.equal(file);
    expect(mkdirs.map((m) => m.callCount)).to.deep.equal([0, 0]);
  });

  it('keeps the head of part 1 only', async () => {
    const s = await sessionOf();
    expect((await storage.writePart(s, 2, bodyOf(Buffer.from('abcd')), 4, undefined)).head.length).to.eq(0);
  });

  it('refuses a body longer than the part with upload.part_too_large, and leaves no object or row', async () => {
    const s = await sessionOf();
    const e = await uploadErrorOf(storage.writePart(s, 1, bodyOf(Buffer.from('abcde')), 4, undefined));
    expect([e.code, e.status]).to.deep.equal(['upload.part_too_large', 413]);
    expect(await rows('upload_blobs', { session_id: s.id })).to.deep.equal([]);
    expect(objectsOf('temp', `uploads/${s.id}`)).to.deep.equal([]);
  });

  it('returns a short body as it is, for the caller to refuse', async () => {
    const s = await sessionOf();
    expect((await storage.writePart(s, 1, bodyOf(Buffer.from('abc')), 4, undefined)).size).to.eq(3);
  });

  it('drains the body when the provider refuses the write, so its client still gets a response, and leaves no row', async () => {
    const s = await sessionOf();
    const writeStream = sinon.stub(getFs('upload-temp'), 'writeStream').rejects(new ResourceDuplicated('taken'));
    const rm = sinon.spy(getFs('upload-temp'), 'rm');
    const body = new PassThrough();

    expect(await rejection(storage.writePart(s, 1, body, 4, undefined))).to.be.instanceOf(ResourceDuplicated);
    expect(writeStream.callCount).to.eq(1);
    expect([body.readableFlowing, body.destroyed]).to.deep.equal([true, false]);
    expect(rm.callCount).to.eq(0);
    expect(await rows('upload_blobs', { session_id: s.id })).to.deep.equal([]);
  });

  it('destroys a refused body that is not a Readable but can be destroyed', async () => {
    const s = await sessionOf();
    sinon.stub(getFs('upload-temp'), 'writeStream').rejects(new ResourceDuplicated('taken'));
    const body = Object.assign(new EventEmitter(), { destroy: sinon.spy(), resume: sinon.spy() });

    await rejection(storage.writePart(s, 1, body as unknown as NodeJS.ReadableStream, 4, undefined));
    expect([body.destroy.callCount, body.resume.callCount]).to.deep.equal([1, 0]);
  });

  it('reports the failure of the pipeline even when the target destroys itself with another error', async () => {
    const s = await sessionOf();
    sinon.stub(getFs('upload-temp'), 'writeStream').callsFake(async () => new Writable({ write: (_c, _e, done) => done(), destroy: (_err, done) => done(new Error('substituted')) }) as never);

    const e = await uploadErrorOf(storage.writePart(s, 1, bodyOf(Buffer.from('abcde')), 4, undefined));
    expect(e.code).to.eq('upload.part_too_large');
    expect(await rows('upload_blobs', { session_id: s.id })).to.deep.equal([]);
  });

  for (const expected of [-1, 1.5]) {
    it(`refuses expected=${expected} before opening anything`, async () => {
      const s = await sessionOf();
      const writeStream = sinon.spy(getFs('upload-temp'), 'writeStream');
      const body = new PassThrough();

      expect(await rejection(storage.writePart(s, 1, body, expected, undefined))).to.be.instanceOf(InvalidArgument);
      expect(writeStream.callCount).to.eq(0);
      expect([body.readableFlowing, body.destroyed]).to.deep.equal([true, false]);
      expect(await rows('upload_blobs', { session_id: s.id })).to.deep.equal([]);
      expect(objectsOf('temp', `uploads/${s.id}`)).to.deep.equal([]);
    });
  }

  it('removes the partial object and its row when the body fails mid-write', async () => {
    const s = await sessionOf();
    const body = new Readable({ read() {} });
    body.push(Buffer.from('ab'));
    // 'resume' fires once the pipeline consumes the body, so its error handler is attached before the destroy.
    body.once('resume', () => setImmediate(() => body.destroy(new Error('client gone'))));

    expect(((await rejection(storage.writePart(s, 1, body, 4, undefined))) as Error).message).to.eq('client gone');
    expect(await rows('upload_blobs', { session_id: s.id })).to.deep.equal([]);
    expect(objectsOf('temp', `uploads/${s.id}`)).to.deep.equal([]);
  });

  it('assembles the parts from the temp provider into the files provider and hashes the whole file', async () => {
    const file = text(10);
    const s = await sessionOf();
    const write = sinon.spy(getFs('upload-files'), 'writeStream');
    const parts = await storeParts(s, [file.subarray(0, 4), file.subarray(4, 8), file.subarray(8)]);

    const assembled = await storage.assemble(s, parts, { dir: 'uploads/files', contentType: 'text/plain', declaredSha256: sha256hex(file) });

    expect(assembled.key).to.match(/^uploads\/files\/[0-9a-f-]{36}\.txt$/);
    expect([assembled.size, assembled.sha256, assembled.corrupted]).to.deep.equal([10, sha256hex(file), []]);
    expect(readFileSync(pathIn('files', assembled.key))).to.deep.equal(file);
    expect(write.firstCall.args[1]).to.deep.equal({ exclusive: true, contentType: 'text/plain', metadata: { hash: sha256hex(file) } });
    expect((await rows('upload_blobs', { key: assembled.key }))[0]).to.include({ fs: 'upload-files', kind: 'file', state: 'writing' });
  });

  it('refuses a file directory with a .. segment, and records or writes nothing for it', async () => {
    for (const dir of ['..', '../outside', 'uploads/../../outside', 'uploads/..', 'uploads\\..\\..\\outside']) {
      expect(() => storage.fileKey(dir, 'notes.txt'), dir).to.throw(InvalidArgument, /\.\./);
    }
    expect(storage.fileKey('/projects/p1..x/files/', 'notes.txt')).to.match(/^projects\/p1\.\.x\/files\/[0-9a-f-]{36}\.txt$/);

    const s = await sessionOf();
    const parts = await storeParts(s, [Buffer.from('abcd')]);
    expect(await rejection(storage.assemble(s, parts, { dir: '../outside', contentType: 'text/plain', declaredSha256: null }))).to.be.instanceOf(InvalidArgument);
    expect(await rows('upload_blobs', { session_id: s.id, kind: 'file' })).to.deep.equal([]);
  });

  it('reports every part whose stored bytes changed, and writes nothing after the first one', async () => {
    const file = text(10);
    const s = await sessionOf();
    const parts = await storeParts(s, [file.subarray(0, 4), file.subarray(4, 8), file.subarray(8)]);
    writeFileSync(pathIn('temp', parts[1].storage_key), 'zzzz');
    rmSync(pathIn('temp', parts[2].storage_key));

    const assembled = await storage.assemble(s, parts, { dir: 'uploads/files', contentType: 'text/plain', declaredSha256: null });

    expect(assembled.corrupted).to.deep.equal([2, 3]);
    // Part 1, then the changed part 2, which is found only at its end.
    expect(readFileSync(pathIn('files', assembled.key)).length).to.eq(8);
  });

  it('discard() marks the blob garbage, removes the object and then the row', async () => {
    const s = await sessionOf();
    const written = await storage.writePart(s, 1, bodyOf(Buffer.from('abcd')), 4, undefined);
    await storage.discard(written.blobId, 'upload-temp', written.key);
    expect(existsSync(pathIn('temp', written.key))).to.eq(false);
    expect(await rows('upload_blobs', { id: written.blobId })).to.deep.equal([]);
  });

  it('keeps the garbage row and warns when the object cannot be removed; removeGarbage() retries it', async () => {
    const s = await sessionOf();
    const written = await storage.writePart(s, 1, bodyOf(Buffer.from('abcd')), 4, undefined);
    const rm = sinon.stub(getFs('upload-temp'), 'rm').rejects(new Error('disk busy'));

    await storage.discard(written.blobId, 'upload-temp', written.key, s.id);

    expect((await rows('upload_blobs', { id: written.blobId }))[0].state).to.eq('garbage');
    expect(uploadLogs(LogLevel.Warn).map((l) => l.Variables.key)).to.deep.equal([written.key]);
    expect(uploadLogs(LogLevel.Warn).map((l) => l.Variables.uploadId)).to.deep.equal([s.id]);

    rm.resetBehavior();
    rm.callThrough();
    await storage.removeGarbage(s.id);
    expect(await rows('upload_blobs', { id: written.blobId })).to.deep.equal([]);
    expect(existsSync(pathIn('temp', written.key))).to.eq(false);
  });

  it('assertFsProviders() names every provider that fs.providers does not define', () => {
    expect(() => assertFsProviders(['upload-temp', 'upload-files'])).to.not.throw();
    expect(() => assertFsProviders(['upload-temp', 'nope', 'nada'])).to.throw(InvalidConfiguration, /nope, nada/);
  });

  it('the strict test provider refuses mkdir, append, rename, move and list, and records each attempt', async () => {
    const provider = getFs('upload-temp');
    for (const call of [() => provider.mkdir('x'), () => provider.append('x', 'y'), () => provider.rename('a', 'b'), () => provider.move('a', 'b'), () => provider.list('')]) await rejection(call());
    expect(StrictFs.Banned).to.deep.equal(['upload-temp:mkdir', 'upload-temp:append', 'upload-temp:rename', 'upload-temp:move', 'upload-temp:list']);
    StrictFs.Banned.length = 0;
  });
});
