import 'mocha';
import { expect } from 'chai';

import type { UploadStateView } from '../../src/index.js';
import { resetUploads } from '../support/env.js';
import { text } from '../support/flow.js';
import { Seen } from './support/calls.js';
import { uploadApp } from './support/app.js';
import { bodyOf, call, digestOf, partOf } from './support/client.js';
import { sha256hex } from '../support/flow.js';

describe('UploadController over HTTP: server-side misconfiguration', function () {
  this.timeout(30000);

  const file = text(10);
  const generic = { code: 'upload.internal', message: 'Internal error' };
  const create = (base: string) => call('post', base).send({ name: 'notes.txt', size: file.length, sha256: sha256hex(file) });

  before(uploadApp);
  beforeEach(async () => {
    await resetUploads();
    Seen.reset();
  });

  it('answers a .. segment in the controller fileDir with a generic 500', async () => {
    const base = '/misconfigured/dir/uploads';
    const id = bodyOf<UploadStateView>(await create(base)).id;
    for (let n = 1; n <= 3; n++) {
      const res = await call('put', `${base}/${id}/parts/${n}`).set('Content-Type', 'application/octet-stream').set('Content-Digest', digestOf(partOf(file, n))).send(partOf(file, n));
      expect(res.status).to.eq(200);
    }

    const res = await call('post', `${base}/${id}/complete`).send({});

    expect([res.status, res.body]).to.deep.equal([500, generic]);
    expect(res.text).to.not.include('a/../b');
  });

  it('answers a zero sessionTtl from limitsFor with a generic 500', async () => {
    const res = await create('/misconfigured/ttl/uploads');

    expect([res.status, res.body]).to.deep.equal([500, generic]);
    expect(res.text).to.not.include('0s');
  });
});
