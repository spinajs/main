import 'mocha';
import './support/detectors.js';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';

import { ContentTypeCheck } from '../src/index.js';
import type { AllowedTypes } from '../src/index.js';
import { uploadLogs } from './support/capture.js';
import { DWG, DXF, PDF, PNG } from './support/detectors.js';
import { resetUploads, uploadEnv } from './support/env.js';

// Letters only: file-type finds no signature in them.
const text = (length: number): Buffer => Buffer.from('abcdefghij'.repeat(Math.ceil(length / 10)).slice(0, length));

describe('ContentTypeCheck', () => {
  let check: ContentTypeCheck;

  before(async () => {
    await uploadEnv();
    check = await DI.resolve(ContentTypeCheck);
  });
  beforeEach(resetUploads);

  it('maps a file name to its MIME type with mime-types, never by content', () => {
    const names = ['plan.dwg', 'plan.dxf', 'a.pdf', 'a.png', 'a.jpg', 'a.tif', 'notes.txt', 'data.csv', 'x.unknownext', 'noext'];
    expect(names.map((n) => check.mimeOf(n))).to.deep.equal(['image/vnd.dwg', 'image/vnd.dxf', 'application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain', 'text/csv', null, null]);
  });

  it('detects built-in types with file-type and names it as the detector', async () => {
    expect(await check.detect(PNG)).to.deep.equal({ mime: 'image/png', detectorId: 'file-type' });
    expect(await check.detect(PDF)).to.deep.equal({ mime: 'application/pdf', detectorId: 'file-type' });
    expect(await check.detect(DWG)).to.deep.equal({ mime: 'image/vnd.dwg', detectorId: 'file-type' });
    expect(await check.detect(text(32))).to.eq(null);
  });

  it('runs the ContentDetectors registered in DI, before the built-in detectors', async () => {
    expect(await check.detect(DXF)).to.deep.equal({ mime: 'image/vnd.dxf', detectorId: 'test-dxf' });
    expect(await check.detect(Buffer.concat([Buffer.from('    '), PDF]))).to.deep.equal({ mime: 'application/pdf', detectorId: 'test-late-pdf' });
  });

  it('treats a detector that throws as no match, and logs it at warn', async () => {
    expect(await check.detect(Buffer.from('BOOM and more bytes'))).to.eq(null);
    expect(uploadLogs(LogLevel.Warn).map((e) => e.Variables.detectorId)).to.deep.equal(['test-exploding']);
  });

  describe('check()', () => {
    const run = (head: Buffer, declaredMime: string | null, allowedTypes: AllowedTypes = '*') => check.check({ head, declaredMime, allowedTypes });

    it('accepts content whose detected type is the declared one', async () => {
      expect(await run(PNG, 'image/png')).to.deep.equal({ accepted: true, detectedMime: 'image/png', detectorId: 'file-type' });
    });

    it('refuses a different detected type with upload.content_mismatch', async () => {
      expect(await run(PDF, 'image/png')).to.deep.equal({ accepted: false, code: 'upload.content_mismatch', detectedMime: 'application/pdf', detectorId: 'file-type' });
    });

    it('accepts undetected content only when its declared type is in allowUndetected', async () => {
      expect(await run(text(16), 'text/plain')).to.deep.equal({ accepted: true, detectedMime: null, detectorId: null });
      expect(await run(text(16), 'image/png')).to.include({ accepted: false, code: 'upload.content_mismatch' });
      expect(await run(text(16), null)).to.include({ accepted: false, code: 'upload.content_mismatch' });
    });

    it('refuses an effective type outside allowedTypes with upload.unsupported_type', async () => {
      expect(await run(PNG, 'image/png', ['application/pdf'])).to.include({ accepted: false, code: 'upload.unsupported_type' });
      expect(await run(PDF, null, ['application/pdf'])).to.include({ accepted: true, detectedMime: 'application/pdf' });
      expect(await run(PDF, null, ['image/png'])).to.include({ accepted: false, code: 'upload.unsupported_type' });
      expect(await run(text(16), 'text/plain', ['text/csv'])).to.include({ accepted: false, code: 'upload.unsupported_type' });
    });
  });
});
