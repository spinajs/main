import { expect } from 'chai';
import 'mocha';
import { writeFileSync } from 'fs';
import os from 'os';
import { join } from 'path';
import { DateTime } from 'luxon';

import { fileExtension, sha256File, storedFileName } from '../src/files.js';

describe('configuration file helpers', () => {
  const at = DateTime.fromISO('2026-09-16T12:15:30.000Z', { zone: 'utc' });

  describe('storedFileName', () => {
    it('appends the upload time before the lowercased extension', () => {
      expect(storedFileName('kalkulator.XLSX', at)).to.equal('kalkulator-20260916-121530.xlsx');
    });

    it('replaces characters outside [\\w.-] in the base name', () => {
      expect(storedFileName('Oferta Q3 (v2).xlsx', at)).to.equal('Oferta_Q3__v2_-20260916-121530.xlsx');
    });

    it('formats the time in UTC', () => {
      expect(storedFileName('a.xlsx', DateTime.fromISO('2026-09-16T14:15:30.000+02:00', { setZone: true }))).to.equal('a-20260916-121530.xlsx');
    });

    it('omits the dot for a name without extension', () => {
      expect(storedFileName('template', at)).to.equal('template-20260916-121530');
    });
  });

  describe('fileExtension', () => {
    it('returns the lowercase extension without the dot', () => {
      expect(fileExtension('Report.Final.XLSX')).to.equal('xlsx');
      expect(fileExtension('report')).to.equal('');
    });
  });

  describe('sha256File', () => {
    it('hashes the file content as hex', async () => {
      const path = join(os.tmpdir(), 'spinajs-cfg-http-hash.txt');
      writeFileSync(path, 'abc');

      expect(await sha256File(path)).to.equal('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });
  });
});
