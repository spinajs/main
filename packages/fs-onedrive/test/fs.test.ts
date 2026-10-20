import 'mocha';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { MethodNotImplemented } from '@spinajs/exceptions';
import { fsOneDrive } from '../src/index.js';

chai.use(chaiAsPromised);

const PUBLIC_FILE_METHODS = [
  'download', 'upload', 'hash', 'metadata', 'read', 'readStream', 'write', 'writeStream', 'append',
  'exists', 'stat', 'dirExists', 'isDir', 'list', 'mkdir', 'rm', 'copy', 'move', 'rename',
  'zip', 'unzip', 'signedUrl', 'getSignedUrl',
];

const HOOKS = [
  'doDownload', 'doUpload', 'doRead', 'doReadStream', 'doWrite', 'doWriteStream', 'doAppend',
  'doExists', 'doDirExists', 'doStat', 'doIsDir', 'doList', 'doMkdir', 'doRm', 'doCopy', 'doMove', 'doRename',
  'doZip', 'doUnzip',
];

describe('fsOneDrive', () => {
  it('overrides no public file method', () => {
    for (const name of PUBLIC_FILE_METHODS) {
      expect(Object.prototype.hasOwnProperty.call(fsOneDrive.prototype, name), name).to.be.false;
    }
  });

  it('implements every abstract provider hook', () => {
    for (const name of HOOKS) {
      expect(Object.prototype.hasOwnProperty.call(fsOneDrive.prototype, name), name).to.be.true;
    }
  });

  it('rejects every file operation with MethodNotImplemented', async () => {
    const od = new fsOneDrive({ tenantId: 't', clientId: 'c', clientSecret: 's', name: 'onedrive-unit', drive: 'd', debug: false });
    const calls: Array<() => Promise<unknown>> = [
      () => od.download('a.txt'),
      () => od.upload('/local/a.txt', 'a.txt'),
      () => od.upload('/local/a.txt', 'a.txt', { exclusive: true }),
      () => od.read('a.txt'),
      () => od.readStream('a.txt'),
      () => od.write('a.txt', 'x'),
      () => od.writeStream('a.txt'),
      () => od.append('a.txt', 'x'),
      () => od.exists('a.txt'),
      () => od.dirExists('dir'),
      () => od.stat('a.txt'),
      () => od.isDir('dir'),
      () => od.list('dir'),
      () => od.mkdir('dir'),
      () => od.rm('a.txt'),
      () => od.copy('a.txt', 'b.txt'),
      () => od.move('a.txt', 'b.txt'),
      () => od.rename('a.txt', 'b.txt'),
      () => od.zip(['a.txt']),
      () => od.unzip('a.zip'),
      () => od.signedUrl('a.txt'),
    ];

    for (const call of calls) {
      await expect(Promise.resolve().then(call)).to.be.rejectedWith(MethodNotImplemented);
    }
  });
});
