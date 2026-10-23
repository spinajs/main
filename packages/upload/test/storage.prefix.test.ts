import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { getFs } from '@spinajs/fs';
import { LogLevel } from '@spinajs/log';
import sinon from 'sinon';

import { UploadStorage } from '../src/index.js';
import { uploadLogs } from './support/capture.js';
import { insertSessionRow, objectsOf, resetUploads, uploadEnv } from './support/env.js';
import { bodyOf } from './support/flow.js';
import { StrictFs } from './support/strict-fs.js';

describe('UploadStorage session prefix', () => {
  let storage: UploadStorage;

  before(async () => {
    await uploadEnv();
    storage = await DI.resolve(UploadStorage);
  });
  beforeEach(resetUploads);
  afterEach(() => {
    sinon.restore();
    expect(StrictFs.Banned).to.deep.equal([]);
  });

  it('every part key starts with the session prefix', () => {
    expect(storage.sessionPrefix('s-1')).to.eq('uploads/s-1');
    expect(storage.partKey('s-1', 7).startsWith('uploads/s-1/00007-')).to.eq(true);
  });

  it('removePrefix removes everything under the prefix with one rm', async () => {
    const session = await (await uploadEnv()).store.requireSession(await insertSessionRow());
    await storage.writePart(session, 1, bodyOf(Buffer.from('abcd')), 4);
    await storage.writePart(session, 2, bodyOf(Buffer.from('efgh')), 4);
    expect(objectsOf('temp', `uploads/${session.id}`)).to.have.length(2);
    const rm = sinon.spy(getFs('upload-temp'), 'rm');

    expect(await storage.removePrefix('upload-temp', session.id)).to.eq(true);

    expect(rm.args).to.deep.equal([[`uploads/${session.id}`]]);
    expect(objectsOf('temp', 'uploads')).to.not.include(session.id);
  });

  it('removePrefix warns with the uploadId and returns false when the rm fails', async () => {
    sinon.stub(getFs('upload-temp'), 'rm').rejects(new Error('disk busy'));
    expect(await storage.removePrefix('upload-temp', 's-1')).to.eq(false);
    expect(uploadLogs(LogLevel.Warn).map((l) => [l.Variables.uploadId, l.Variables.key, l.Variables.fs])).to.deep.equal([['s-1', 'uploads/s-1', 'upload-temp']]);
  });
});
