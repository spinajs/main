import 'mocha';
import { expect } from 'chai';
import { IOFail } from '@spinajs/exceptions';
import { getFs } from '@spinajs/fs';
import { LogLevel } from '@spinajs/log';
import sinon from 'sinon';

import type { UploadErrorBody } from '../../src/http/index.js';
import type { UploadStateView } from '../../src/index.js';
import { uploadLogs } from '../support/capture.js';
import { resetUploads, rows } from '../support/env.js';
import { text } from '../support/flow.js';
import { Seen } from './support/calls.js';
import { appPort, uploadApp } from './support/app.js';
import { BASE, bodyOf, call, createUpload, digestOf, partOf, sendPart } from './support/client.js';
import { rawRequest, wait } from './support/raw.js';

const SECRET_PATH = 'C:\\srv\\secret-volume\\uploads\\files';

describe('UploadController over HTTP: unmapped errors', function () {
  this.timeout(30000);

  const file = text(10);
  const generic = { code: 'upload.internal', message: 'Internal error' };

  const uploaded = async (): Promise<string> => {
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;
    for (let n = 1; n <= 3; n++) expect(await sendPart(id, n, partOf(file, n))).to.have.status(200);
    return id;
  };

  before(uploadApp);
  beforeEach(async () => {
    await resetUploads();
    Seen.reset();
  });
  afterEach(() => sinon.restore());

  it('answers a storage IOFail during complete with a generic 500 that names no path, and logs the original', async () => {
    const id = await uploaded();
    sinon.stub(getFs('upload-files'), 'writeStream').rejects(new IOFail(`EACCES: permission denied, open '${SECRET_PATH}\\x.txt'`));

    const res = await call('post', `${BASE}/${id}/complete`).send({});

    expect(res.status).to.eq(500);
    expect(res.body).to.deep.equal(generic);
    expect(res.text).to.not.include('secret-volume').and.not.include('EACCES');
    const logged = uploadLogs(LogLevel.Error).filter((e) => e.Variables.uploadId === id && e.Variables.stage === 'action');
    expect(logged).to.have.length(1);
    expect(String(logged[0].Variables.error?.message)).to.include(SECRET_PATH);
  });

  it('answers a storage failure of a part only after the putPart drain, with the generic 500', async () => {
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;
    sinon.stub(getFs('upload-temp'), 'writeStream').rejects(new IOFail(`EACCES: permission denied, open '${SECRET_PATH}'`));
    const exchange = rawRequest(appPort(), 'PUT', `${BASE}/${id}/parts/1`, { 'content-type': 'application/octet-stream', 'content-length': 4, 'content-digest': digestOf(partOf(file, 1)), 'x-test-owner': 'alice' });
    exchange.write(Buffer.from('ab'));
    await wait(300);
    expect(exchange.answered(), 'answered while the client was still sending').to.eq(false);

    exchange.end(Buffer.from('cd'));
    const res = await exchange.response;
    expect([res.status, JSON.parse(res.body), res.headers.connection]).to.deep.equal([500, generic, 'keep-alive']);
  });

  it('answers a raw error of an app hook with the same generic 500', async () => {
    const id = await uploaded();
    Seen.failCompletions = 1;

    const res = await call('post', `${BASE}/${id}/complete`).send({});

    expect([res.status, res.body]).to.deep.equal([500, generic]);
    expect(res.text).to.not.include('onCompleted failed in the test');
  });

  it('leaves the answers the framework maps itself unchanged', async () => {
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;

    const forbidden = await call('get', `${BASE}/${id}`, { headers: { 'x-test-deny': 'read' } });
    expect(forbidden.status).to.eq(403);
    expect(bodyOf<UploadErrorBody>(forbidden).code).to.not.eq('upload.internal');

    const invalid = await call('post', BASE).send({ name: 'notes.txt' });
    expect(invalid.status).to.eq(400);
    expect(bodyOf<UploadErrorBody>(invalid).code).to.not.eq('upload.internal');

    const missing = await call('get', `${BASE}/00000000-0000-4000-8000-000000000000`);
    expect([missing.status, bodyOf<UploadErrorBody>(missing).code]).to.deep.equal([404, 'upload.not_found']);
    expect(await rows('upload_sessions')).to.have.length(1);
  });
});
