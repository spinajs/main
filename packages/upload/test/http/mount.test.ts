import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';

import shipped from '../../src/config/upload.js';
import type { UploadStateView } from '../../src/index.js';
import { CaptureQueueClient, emitted } from '../support/capture.js';
import { resetUploads, rows } from '../support/env.js';
import { text } from '../support/flow.js';
import { Seen } from './support/calls.js';
import { uploadApp } from './support/app.js';
import { BASE, bodyOf, call, createUpload, partOf, sendPart } from './support/client.js';

describe('UploadController mounting', function () {
  this.timeout(30000);

  before(uploadApp);
  beforeEach(resetUploads);

  it('mounts the subclass from the suite controllers dir and never the abstract base', async () => {
    const mounted = (DI.getRegisteredTypes(BaseController) ?? []).map((type) => (type as { name: string }).name);
    expect(mounted).to.include('TestUploadController').and.not.include('UploadController');

    const id = bodyOf<UploadStateView>(await createUpload(text(10))).id;
    expect((await call('get', `/projects/p-1/uploads/${id}`)).status).to.eq(200);
    // Without @BasePath the base would sit under its lower-cased class name (http/src/base-controller.ts:60-72).
    expect((await call('get', `/uploadcontroller/${id}`)).status).to.eq(404);
  });

  it('answers 404 on every route of the abstract base at its own path, for a session the subclass serves', async () => {
    const file = text(10);
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;
    expect((await call('head', `${BASE}/${id}`)).status).to.eq(200);

    const own = '/uploadcontroller';
    const statuses = [
      (await call('post', own).send({ name: 'notes.txt', size: 10 })).status,
      (await call('head', `${own}/${id}`)).status,
      (await call('get', `${own}/${id}`)).status,
      (await call('put', `${own}/${id}/parts/1`).set('Content-Type', 'application/octet-stream').send(file.subarray(0, 4))).status,
      (await call('post', `${own}/${id}/complete`).send({})).status,
      (await call('delete', `${own}/${id}`)).status,
    ];
    expect(statuses).to.deep.equal([404, 404, 404, 404, 404, 404]);
    expect(bodyOf<UploadStateView>(await call('get', `${BASE}/${id}`))).to.deep.include({ status: 'open', receivedParts: [] });
  });

  it('ships no system.dirs.controllers entry (spec D6)', () => {
    // system.dirs.cli is shipped for upload:sweep (plan 8); a controllers entry next to it would mount the base.
    expect(shipped).to.not.have.nested.property('system.dirs.controllers');
  });

  // TypeScript refuses such a subclass (controllers/UnguardedUploadController.ts); this is the run-time side (spec D7).
  it('fails closed for a JavaScript subclass without authorize: 500 on every route, and nothing changes', async () => {
    const file = text(10);
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;
    Seen.reset();
    CaptureQueueClient.reset();
    const own = '/unguarded/uploads';
    const internal = { code: 'upload.internal', message: 'Internal error' };

    const answers = [
      await call('post', own).send({ name: 'notes.txt', size: 10 }),
      await call('get', `${own}/${id}`),
      await call('put', `${own}/${id}/parts/1`).set('Content-Type', 'application/octet-stream').send(partOf(file, 1)),
      await call('post', `${own}/${id}/complete`).send({}),
      await call('delete', `${own}/${id}`),
    ];

    expect(answers.map((res) => [res.status, bodyOf<unknown>(res)])).to.deep.equal(answers.map(() => [500, internal]));
    expect((await rows('upload_sessions')).map((r) => [r.id, r.status])).to.deep.equal([[id, 'open']]);
    expect(await rows('upload_parts', { session_id: id })).to.deep.equal([]);
    expect(Seen.hooks).to.deep.equal([]);
    expect(emitted()).to.deep.equal([]);
    expect(await sendPart(id, 1, partOf(file, 1))).to.have.status(200);
  });
});
