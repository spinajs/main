import { expect } from 'chai';
import 'mocha';
import { DateTime } from 'luxon';
import { FileTypeEnum } from '@spinajs/http';

import { checkFileRules, fileExtension, storedFileName } from '../src/files.js';

const AT = DateTime.fromISO('2026-09-16T12:15:30.000Z', { zone: 'utc' });
const XLSX = { fs: 'files', extensions: ['xlsx'], mimeTypes: [FileTypeEnum.xlsx], maxSize: 1024 };

const candidate = (over: Partial<{ originalName: string; size: number; mimeType: string }> = {}) => ({
  localPath: '/tmp/upload',
  originalName: 'report.xlsx',
  size: 10,
  mimeType: FileTypeEnum.xlsx,
  ...over,
});

describe('configuration file helpers', () => {
  describe('storedFileName', () => {
    it('appends the upload time before the lowercased extension', () => {
      expect(storedFileName('kalkulator.XLSX', AT)).to.equal('kalkulator-20260916-121530.xlsx');
    });

    it('replaces characters outside [\\w.-] in the base name', () => {
      expect(storedFileName('Oferta Q3 (v2).xlsx', AT)).to.equal('Oferta_Q3__v2_-20260916-121530.xlsx');
    });

    it('formats the time in UTC', () => {
      expect(storedFileName('a.xlsx', DateTime.fromISO('2026-09-16T14:15:30.000+02:00', { setZone: true }))).to.equal('a-20260916-121530.xlsx');
    });

    it('omits the dot for a name without extension', () => {
      expect(storedFileName('template', AT)).to.equal('template-20260916-121530');
    });

    it('caps the base name at 100 characters', () => {
      expect(storedFileName(`${'a'.repeat(300)}.xlsx`, AT)).to.equal(`${'a'.repeat(100)}-20260916-121530.xlsx`);
    });

    it('uses "file" when the name has no base', () => {
      expect(storedFileName('', AT)).to.equal('file-20260916-121530');
    });
  });

  describe('fileExtension', () => {
    it('returns the lowercase extension without the dot', () => {
      expect(fileExtension('Report.Final.XLSX')).to.equal('xlsx');
      expect(fileExtension('report')).to.equal('');
    });
  });

  describe('checkFileRules', () => {
    it('accepts a candidate inside every rule', () => {
      expect(checkFileRules(XLSX, candidate())).to.equal(null);
    });

    it('rejects in rule order: name length, extension length, size, extension, content type', () => {
      expect(checkFileRules(XLSX, candidate({ originalName: `${'a'.repeat(252)}.xlsx` }))).to.contain('255');
      expect(checkFileRules(XLSX, candidate({ originalName: `a.${'x'.repeat(20)}` }))).to.contain('16');
      expect(checkFileRules(XLSX, candidate({ size: 1025 }))).to.contain('too large');
      expect(checkFileRules(XLSX, candidate({ originalName: 'report.pdf' }))).to.contain('extension must be one of');
      expect(checkFileRules(XLSX, candidate({ mimeType: 'text/plain' }))).to.contain('text/plain');
    });

    it('applies the default size limit and skips the lists that are not set', () => {
      expect(checkFileRules({ fs: 'x' }, candidate({ originalName: 'anything.bin', mimeType: 'application/octet-stream', size: 10 * 1024 * 1024 }))).to.equal(null);
      expect(checkFileRules({ fs: 'x' }, candidate({ size: 10 * 1024 * 1024 + 1 }))).to.contain('too large');
    });
  });
});
