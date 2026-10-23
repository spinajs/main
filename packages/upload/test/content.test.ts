import 'mocha';
import './support/detectors.js';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { LogLevel } from '@spinajs/log';

import { ContentTypeCheck } from '../src/index.js';
import type { AllowedTypes } from '../src/index.js';
import { uploadLogs } from './support/capture.js';
import { AVI, CFB, DWG, DXF, EPS, ICO, PDF, PNG, PNG_OVERRIDE, TRUNCATED_ZIP } from './support/detectors.js';
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

  it('lets an app detector win over file-type on the same bytes', async () => {
    expect(await check.detect(PNG_OVERRIDE)).to.deep.equal({ mime: 'image/x-test-png', detectorId: 'test-png-override' });
  });

  it('treats a truncated zip head as nothing detected, and logs without content', async () => {
    expect(await check.detect(TRUNCATED_ZIP)).to.eq(null);
    const warns = uploadLogs(LogLevel.Warn);
    expect(warns.map((e) => e.Variables.detectorId)).to.deep.equal(['file-type']);
    expect(JSON.stringify(warns.map((e) => e.Variables))).to.not.include('PK');
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

    it('applies the undetected rules to a truncated zip head', async () => {
      expect(await run(TRUNCATED_ZIP, 'application/zip')).to.include({ accepted: false, code: 'upload.content_mismatch' });
      expect(await run(TRUNCATED_ZIP, 'text/plain')).to.include({ accepted: true, detectedMime: null });
    });

    it('accepts a detected type whose extension maps to the declared mime-types name', async () => {
      const m = (n: string) => check.mimeOf(n);
      expect(await run(ICO, m('a.ico'))).to.include({ accepted: true, detectedMime: 'image/x-icon' });
      expect(await run(AVI, m('a.avi'))).to.include({ accepted: true, detectedMime: 'video/vnd.avi' });
      expect(await run(EPS, m('a.eps'))).to.include({ accepted: true, detectedMime: 'application/eps' });
    });

    it('still refuses a real mismatch, PNG bytes named .pdf', async () => {
      expect(await run(PNG, check.mimeOf('a.pdf'))).to.include({ accepted: false, code: 'upload.content_mismatch' });
    });

    it('refuses .doc and .xls: CFB is a container, the type is unknowable from the head', async () => {
      expect(await run(CFB, check.mimeOf('a.doc'))).to.include({ accepted: false, code: 'upload.content_mismatch', detectedMime: 'application/x-cfb' });
      expect(await run(CFB, check.mimeOf('a.xls'))).to.include({ accepted: false, code: 'upload.content_mismatch' });
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
