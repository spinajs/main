import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { BaseController } from '@spinajs/http';

import shipped from '../../src/config/upload.js';
import { UploadController } from '../../src/http/index.js';
import type { UploadStateView } from '../../src/index.js';
import { resetUploads } from '../support/env.js';
import { text } from '../support/flow.js';
import { uploadApp } from './support/app.js';
import { BASE, bodyOf, call, createUpload } from './support/client.js';

// @ts-expect-error authorize is abstract: a subclass that leaves it out does not compile (fail closed, spec D7).
class Unguarded extends UploadController {}

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
    expect(shipped.system.dirs).to.not.have.property('controllers');
  });

  it('gives a subclass no authorize of its own', () => {
    expect(Unguarded.prototype).to.not.have.property('authorize');
  });
});
