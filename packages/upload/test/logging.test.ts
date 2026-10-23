import 'mocha';
import './support/detectors.js';
import { expect } from 'chai';
import { writeFileSync } from 'node:fs';
import { getFs } from '@spinajs/fs';
import { LogLevel } from '@spinajs/log';
import sinon from 'sinon';

import type { UploadService } from '../src/index.js';
import { uploadLogs } from './support/capture.js';
import { PDF } from './support/detectors.js';
import { pathIn, resetUploads, rows, uploadEnv } from './support/env.js';
import { bodyOf, chunk, open, put, putAll, sha256hex, sha256raw, text, uploadErrorOf } from './support/flow.js';

describe('upload logging (spec §6.7)', () => {
  let service: UploadService;
  const file = text(10);
  const SECRET = 'TOP-SECRET-VALUE';
  const at = (level: LogLevel, pattern: RegExp) => uploadLogs(level).filter((e) => pattern.test(String(e.Variables.message)));

  before(async () => {
    ({ service } = await uploadEnv());
  });
  beforeEach(resetUploads);
  afterEach(() => sinon.restore());

  it('logs each stage at its level with the upload id, and never a metadata value', async () => {
    const session = await open(service, file, { owner: 'alice', metadata: { apiKey: SECRET } });
    await put(service, session, file, 1);
    await uploadErrorOf(service.putPart(session, 2, bodyOf(chunk(session, file, 2)), sha256raw(Buffer.from('zzzz')), 4));
    await put(service, session, file, 2);
    await put(service, session, file, 3);
    await service.complete(session);
    const aborted = await open(service, file, { owner: 'alice', metadata: { apiKey: SECRET } });
    await service.abort(aborted);

    const created = at(LogLevel.Info, /created/);
    expect(created.map((e) => e.Variables.uploadId)).to.deep.equal([session.id, aborted.id]);
    expect(created[0].Variables).to.include({ owner: 'alice' }).and.have.deep.property('metadataKeys', ['apiKey']);
    expect(at(LogLevel.Debug, /part \d+ stored/).map((e) => [e.Variables.uploadId, e.Variables.part])).to.deep.equal([
      [session.id, 1],
      [session.id, 2],
      [session.id, 3],
    ]);
    expect(at(LogLevel.Warn, /rejected/).map((e) => [e.Variables.part, e.Variables.code])).to.deep.equal([[2, 'upload.part_digest_mismatch']]);
    expect(at(LogLevel.Debug, /content checked/)).to.have.length(1);
    expect(at(LogLevel.Debug, /claim taken/)).to.have.length(1);
    expect(at(LogLevel.Info, /assembly started/)).to.have.length(1);
    expect(at(LogLevel.Info, /completed/).map((e) => e.Variables.uploadId)).to.deep.equal([session.id]);
    expect(at(LogLevel.Info, /aborted/).map((e) => e.Variables.uploadId)).to.deep.equal([aborted.id]);
    expect(JSON.stringify(uploadLogs().map((e) => e.Variables))).to.not.contain(SECRET);
  });

  it('logs a changed stored part at warn and a failed upload at info, with their codes', async () => {
    const changed = await open(service, file);
    await putAll(service, changed, file);
    const [part3] = await rows('upload_parts', { session_id: changed.id, number: 3 });
    writeFileSync(pathIn('temp', part3.storage_key as string), 'zz');
    await uploadErrorOf(service.complete(changed));
    expect(at(LogLevel.Warn, /stored parts changed/).map((e) => [e.Variables.uploadId, e.Variables.parts])).to.deep.equal([[changed.id, [3]]]);

    const failed = await open(service, file, { sha256: sha256hex(text(10, 5)) });
    await putAll(service, failed, file);
    await uploadErrorOf(service.complete(failed));
    expect(at(LogLevel.Info, /failed/).map((e) => [e.Variables.uploadId, e.Variables.code])).to.deep.equal([[failed.id, 'upload.file_digest_mismatch']]);
  });

  describe('every warn, info and error entry of a known session carries its uploadId', () => {
    const withoutId = () => uploadLogs().filter((e) => e.Level !== LogLevel.Debug && e.Variables.uploadId === undefined);

    it('when a refused part cannot be cleaned up', async () => {
      sinon.stub(getFs('upload-temp'), 'rm').rejects(new Error('disk busy'));
      const session = await open(service, file, { allowUnknownType: true, metadata: { apiKey: SECRET } });
      await uploadErrorOf(service.putPart(session, 2, bodyOf(chunk(session, file, 2)), sha256raw(Buffer.from('zzzz')), 4));
      await uploadErrorOf(service.putPart(session, 2, bodyOf(Buffer.from('abc')), sha256raw(Buffer.from('abc')), 4));

      expect(uploadLogs(LogLevel.Warn).filter((e) => e.Variables.key !== undefined)).to.have.length.of.at.least(2);
      expect(withoutId()).to.deep.equal([]);
      expect(JSON.stringify(uploadLogs().map((e) => e.Variables))).to.not.contain(SECRET);
    });

    it('when the content of part 1 is refused and its object cannot be removed', async () => {
      sinon.stub(getFs('upload-temp'), 'rm').rejects(new Error('disk busy'));
      const pdf = Buffer.concat([PDF, text(15)]);
      const session = await open(service, pdf, { name: 'image.png', partSize: 16, metadata: { apiKey: SECRET } });
      await uploadErrorOf(put(service, session, pdf, 1));

      expect(uploadLogs(LogLevel.Warn).filter((e) => e.Variables.key !== undefined)).to.have.length(1);
      expect(withoutId()).to.deep.equal([]);
    });

    it('when a content detector fails during a part', async () => {
      const boom = Buffer.concat([Buffer.from('BOOM'), text(12)]);
      const session = await open(service, boom, { partSize: 16 });
      await put(service, session, boom, 1);

      const failures = uploadLogs(LogLevel.Warn).filter((e) => e.Variables.detectorId === 'test-exploding');
      expect(failures.map((e) => e.Variables.uploadId)).to.deep.equal([session.id]);
      expect(withoutId()).to.deep.equal([]);
    });
  });
});
