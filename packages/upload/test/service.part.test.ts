import 'mocha';
import './support/detectors.js';
import { expect } from 'chai';
import { existsSync, readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';
import { DateTime } from 'luxon';
import sinon from 'sinon';

import { UploadStorage } from '../src/index.js';
import type { UploadErrorCode, UploadService, UploadStore } from '../src/index.js';
import { emitted, uploadLogs } from './support/capture.js';
import { DXF, PDF, PNG } from './support/detectors.js';
import { objectsOf, pathIn, resetUploads, rows, setSession, uploadEnv } from './support/env.js';
import { bodyOf, chunk, open, put, sha256hex, sha256raw, text, uploadErrorOf } from './support/flow.js';
import { StrictFs } from './support/strict-fs.js';

describe('UploadService.putPart', () => {
  let service: UploadService;
  let store: UploadStore;
  let storage: UploadStorage;
  const file = text(10);

  before(async () => {
    ({ service, store } = await uploadEnv());
    storage = await DI.resolve(UploadStorage);
  });
  beforeEach(resetUploads);
  afterEach(() => {
    sinon.restore();
    expect(StrictFs.Banned).to.deep.equal([]);
  });

  it('stores a part under its own key, commits its row and blob, and answers the offset and missing parts', async () => {
    const session = await open(service, file);
    const stored = await put(service, session, file, 1);

    expect(stored).to.deep.equal({ part: 1, size: 4, sha256: sha256hex(chunk(session, file, 1)), offset: 4, missingParts: [2, 3] });
    const [row] = await rows('upload_parts', { session_id: session.id });
    expect(row).to.include({ number: 1, size: 4, sha256: stored.sha256, detected_mime: null });
    expect(row.storage_key).to.match(new RegExp(`^uploads/${session.id}/00001-[0-9a-f-]{36}$`));
    expect(readFileSync(pathIn('temp', row.storage_key as string))).to.deep.equal(chunk(session, file, 1));
    expect((await rows('upload_blobs', { session_id: session.id })).map((b) => [b.key, b.kind, b.state])).to.deep.equal([[row.storage_key, 'part', 'live']]);
    expect(emitted('UploadPartStored')[0]).to.include({ Part: 1, PartSize: 4, PartSha256: stored.sha256, Offset: 4, ReceivedParts: 1, PartCount: 3, Replaced: false });
  });

  it('answers the resume state after parts arrive out of order', async () => {
    const session = await open(service, file);
    await put(service, session, file, 3);
    await put(service, session, file, 1);
    const view = await service.state(session);
    expect(view.receivedParts.map((p) => [p.number, p.size])).to.deep.equal([
      [1, 4],
      [3, 2],
    ]);
    expect([view.missingParts, view.offset]).to.deep.equal([[2], 4]);
  });

  it('lets a resend replace a part: the row points at the new key and the old copy is removed', async () => {
    const session = await open(service, file);
    await put(service, session, file, 2);
    const [first] = await rows('upload_parts', { session_id: session.id, number: 2 });
    await put(service, session, file, 2);
    const [second] = await rows('upload_parts', { session_id: session.id, number: 2 });

    expect(second.storage_key).to.not.eq(first.storage_key);
    expect(existsSync(pathIn('temp', first.storage_key as string))).to.eq(false);
    expect((await rows('upload_blobs', { session_id: session.id })).map((b) => b.key)).to.deep.equal([second.storage_key]);
    expect(emitted('UploadPartStored').map((e): unknown => e.Replaced)).to.deep.equal([false, true]);
  });

  describe('refusals', () => {
    /** The refusal leaves no part row, no blob row and no object, emits UploadPartRejected and logs it at warn. */
    async function refused(work: Promise<unknown>, sessionId: string, code: UploadErrorCode, status: number): Promise<void> {
      const e = await uploadErrorOf(work);
      expect([e.code, e.status]).to.deep.equal([code, status]);
      expect(await rows('upload_parts', { session_id: sessionId })).to.deep.equal([]);
      expect(await rows('upload_blobs', { session_id: sessionId })).to.deep.equal([]);
      expect(objectsOf('temp', `uploads/${sessionId}`)).to.deep.equal([]);
      expect(emitted('UploadPartRejected').map((x): unknown[] => [x.Part, x.Code])).to.deep.equal([[1, code]]);
      expect(uploadLogs(LogLevel.Warn).map((x) => x.Variables.code)).to.include(code);
    }

    it('a part number outside 1..partCount: upload.part_number', async () => {
      const session = await open(service, file);
      const e = await uploadErrorOf(service.putPart(session, 4, bodyOf(Buffer.alloc(2)), sha256raw(Buffer.alloc(2)), 2));
      expect([e.code, e.status]).to.deep.equal(['upload.part_number', 400]);
    });

    it('no length: upload.length_required (411)', async () => {
      const session = await open(service, file);
      const bytes = chunk(session, file, 1);
      await refused(service.putPart(session, 1, bodyOf(bytes), sha256raw(bytes), undefined), session.id, 'upload.length_required', 411);
    });

    it('a length other than the part size, before the body is read: upload.part_size', async () => {
      const session = await open(service, file);
      const bytes = chunk(session, file, 1);
      const body = bodyOf(bytes);
      await refused(service.putPart(session, 1, body, sha256raw(bytes), 3), session.id, 'upload.part_size', 400);
      expect((body as Readable).readableEnded).to.eq(false);
    });

    it('never hands the storage a body whose length is missing or not the part size', async () => {
      const session = await open(service, file);
      const writePart = sinon.spy(storage, 'writePart');
      const bytes = chunk(session, file, 1);
      for (const length of [undefined, 3, 5]) {
        const e = await uploadErrorOf(service.putPart(session, 1, bodyOf(bytes), sha256raw(bytes), length));
        expect(e.code).to.be.oneOf(['upload.length_required', 'upload.part_size']);
      }
      expect(writePart.callCount).to.eq(0);
    });

    it('no sha-256 digest: upload.digest_required', async () => {
      const session = await open(service, file);
      await refused(service.putPart(session, 1, bodyOf(chunk(session, file, 1)), undefined, 4), session.id, 'upload.digest_required', 400);
    });

    it('a body shorter than its length: upload.part_size after the stream', async () => {
      const session = await open(service, file);
      await refused(service.putPart(session, 1, bodyOf(Buffer.from('abc')), sha256raw(Buffer.from('abc')), 4), session.id, 'upload.part_size', 400);
    });

    it('a body longer than the part: upload.part_too_large (413)', async () => {
      const session = await open(service, file);
      await refused(service.putPart(session, 1, bodyOf(Buffer.from('abcde')), sha256raw(Buffer.from('abcd')), 4), session.id, 'upload.part_too_large', 413);
    });

    it('bytes that do not match the digest: upload.part_digest_mismatch', async () => {
      const session = await open(service, file);
      await refused(service.putPart(session, 1, bodyOf(chunk(session, file, 1)), sha256raw(Buffer.from('zzzz')), 4), session.id, 'upload.part_digest_mismatch', 400);
    });

    it('a session past expires_at: upload.expired (410)', async () => {
      const session = await open(service, file);
      await setSession(session.id, { expires_at: DateTime.utc().minus({ minutes: 1 }) });
      await refused(put(service, await service.get(session.id), file, 1), session.id, 'upload.expired', 410);
    });

    it('a session that is no longer open, also when the caller holds a stale copy: upload.not_open', async () => {
      const session = await open(service, file);
      await setSession(session.id, { status: 'aborted' });
      // The stale copy still says open: the body is stored, then the commit's touchOpen matches no row and removes it.
      await refused(put(service, session, file, 1), session.id, 'upload.not_open', 409);
      const fresh = await uploadErrorOf(put(service, await service.get(session.id), file, 1));
      expect(fresh.code).to.eq('upload.not_open');
    });

    it('a part whose blob is reclaimed between the write and the commit: upload.part_lost (409)', async () => {
      const session = await open(service, file);
      const original = storage.writePart.bind(storage);
      sinon.stub(storage, 'writePart').callsFake(async (...args: Parameters<UploadStorage['writePart']>) => {
        const written = await original(...args);
        await store.setBlobState(written.blobId, 'writing', 'garbage', DateTime.utc());
        return written;
      });
      await refused(put(service, session, file, 1), session.id, 'upload.part_lost', 409);
    });

    it('stores a part without a digest once upload.integrity.partDigest is optional', async () => {
      const cfg = await DI.resolve(Configuration);
      cfg.set('upload.integrity.partDigest', 'optional');
      try {
        const session = await open(service, file);
        const stored = await service.putPart(session, 1, bodyOf(chunk(session, file, 1)), undefined, 4);
        expect(stored.sha256).to.eq(sha256hex(chunk(session, file, 1)));
      } finally {
        cfg.set('upload.integrity.partDigest', 'required');
      }
    });
  });

  describe('the content of part 1', () => {
    const png = Buffer.concat([PNG, text(8)]);
    const pdf = Buffer.concat([PDF, text(15)]);

    it('stores the detected type with part 1 and reports the check', async () => {
      const session = await open(service, png, { name: 'image.png', partSize: 16 });
      await put(service, session, png, 1);
      expect((await rows('upload_parts', { session_id: session.id, number: 1 }))[0].detected_mime).to.eq('image/png');
      expect(emitted('UploadContentChecked')[0]).to.include({ DeclaredMime: 'image/png', DetectedMime: 'image/png', DetectorId: 'file-type', Accepted: true });
      expect((await service.state(session)).mime).to.eq('image/png');
    });

    it('refuses content of another type with upload.content_mismatch (415) and stores nothing', async () => {
      const session = await open(service, pdf, { name: 'image.png', partSize: 16 });
      const e = await uploadErrorOf(put(service, session, pdf, 1));
      expect([e.code, e.status]).to.deep.equal(['upload.content_mismatch', 415]);
      expect(await rows('upload_parts', { session_id: session.id })).to.deep.equal([]);
      expect(objectsOf('temp', `uploads/${session.id}`)).to.deep.equal([]);
      expect(emitted('UploadContentChecked')[0]).to.include({ DetectedMime: 'application/pdf', Accepted: false });
      expect(emitted('UploadPartRejected')[0]).to.include({ Part: 1, Code: 'upload.content_mismatch' });
    });

    it('accepts a type that only a registered ContentDetector knows', async () => {
      const dxf = Buffer.concat([DXF, text(9)]);
      const session = await open(service, dxf, { name: 'plan.dxf', partSize: 16 });
      await put(service, session, dxf, 1);
      expect((await rows('upload_parts', { session_id: session.id, number: 1 }))[0].detected_mime).to.eq('image/vnd.dxf');
      expect(emitted('UploadContentChecked')[0]).to.include({ DetectorId: 'test-dxf', Accepted: true });
    });

    it('refuses a detected type outside allowedTypes with upload.unsupported_type (415)', async () => {
      const session = await open(service, pdf, { name: 'blob.unknownext', partSize: 16, allowUnknownType: true });
      const e = await uploadErrorOf(put(service, session, pdf, 1, { allowedTypes: ['image/png'] }));
      expect([e.code, e.status]).to.deep.equal(['upload.unsupported_type', 415]);
      await put(service, session, pdf, 1, { allowedTypes: ['application/pdf'] });
    });

    it('does not check the other parts', async () => {
      const session = await open(service, png, { name: 'image.png', partSize: 16 });
      await put(service, session, png, 2);
      expect(emitted('UploadContentChecked')).to.deep.equal([]);
    });
  });
});
