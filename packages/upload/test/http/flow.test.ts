import 'mocha';
import { expect } from 'chai';

import type { PartStoredView, UploadStateView } from '../../src/index.js';
import { CaptureQueueClient, emitted } from '../support/capture.js';
import { resetUploads, rows } from '../support/env.js';
import { sha256hex, text } from '../support/flow.js';
import { Seen } from './support/calls.js';
import { appPort, uploadApp } from './support/app.js';
import { BASE, bodyOf, call, createUpload, partOf, sendPart } from './support/client.js';
import { rawRequest } from './support/raw.js';

describe('UploadController over HTTP: the resumable flow', function () {
  this.timeout(30000);

  const file = text(10);

  before(uploadApp);
  beforeEach(async () => {
    await resetUploads();
    Seen.reset();
  });

  it('creates, takes parts out of order and resent, reports the resume state, and completes once', async () => {
    const created = await createUpload(file, { metadata: { note: 'n' } });
    expect(created).to.have.status(201);
    const view = bodyOf<UploadStateView>(created);
    expect(created).to.have.header('location', `${BASE}/${view.id}`);
    expect(view).to.deep.include({ status: 'open', name: 'notes.txt', size: 10, partSize: 4, partCount: 3, receivedParts: [], missingParts: [1, 2, 3], offset: 0 });
    const [row] = await rows('upload_sessions', { id: view.id });
    expect(row.owner).to.eq('alice');
    expect(JSON.parse(row.metadata as string)).to.deep.equal({ note: 'n', project: 'p-1' });

    const second = await sendPart(view.id, 2, partOf(file, 2));
    expect(second).to.have.status(200);
    expect(bodyOf<PartStoredView>(second)).to.deep.equal({ part: 2, size: 4, sha256: sha256hex(partOf(file, 2)), offset: 0, missingParts: [1, 3] });
    expect(bodyOf<PartStoredView>(await sendPart(view.id, 1, partOf(file, 1)))).to.deep.include({ part: 1, offset: 8, missingParts: [3] });
    const resent = await sendPart(view.id, 1, partOf(file, 1));
    expect(resent).to.have.status(200);
    expect(bodyOf<PartStoredView>(resent)).to.deep.include({ part: 1, offset: 8, missingParts: [3] });
    expect(emitted('UploadPartStored').map((e): unknown[] => [e.Part, e.Replaced])).to.deep.equal([
      [2, false],
      [1, false],
      [1, true],
    ]);

    const head = await call('head', `${BASE}/${view.id}`);
    expect(head).to.have.status(200);
    expect([head.get('Upload-Offset'), head.get('Upload-Length'), head.get('Upload-Part-Size')]).to.deep.equal(['8', '10', '4']);

    const state = bodyOf<UploadStateView>(await call('get', `${BASE}/${view.id}`));
    expect(state).to.deep.include({ status: 'open', offset: 8, missingParts: [3] });
    expect(state.receivedParts.map((p) => p.number)).to.deep.equal([1, 2]);

    await sendPart(view.id, 3, partOf(file, 3));
    const completed = await call('post', `${BASE}/${view.id}/complete`).send({});
    expect(completed).to.have.status(200);
    expect(bodyOf<UploadStateView>(completed)).to.deep.include({ status: 'completed', sha256: sha256hex(file), offset: 10, missingParts: [] });
    const again = await call('post', `${BASE}/${view.id}/complete`);
    expect(again).to.have.status(200);
    expect(bodyOf<UploadStateView>(again)).to.deep.include({ status: 'completed' });

    expect(Seen.hooks).to.deep.equal([{ hook: 'onCompleted', id: view.id, status: 'completed', project: 'p-1' }]);
    expect(Seen.authorized.map((a) => a.action)).to.deep.equal(['create', 'putPart', 'putPart', 'putPart', 'read', 'read', 'putPart', 'complete', 'complete']);
    // No event was emitted inside a transaction: the controller never wraps the service (spec §6.6).
    expect(CaptureQueueClient.Captured.filter((c) => c.inTransaction)).to.deep.equal([]);
  });

  it('aborts with 204, runs onAborted once, and answers a repeated DELETE with 204', async () => {
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;
    await sendPart(id, 1, partOf(file, 1));

    expect(await call('delete', `${BASE}/${id}`)).to.have.status(204);
    expect(bodyOf<UploadStateView>(await call('get', `${BASE}/${id}`))).to.deep.include({ status: 'aborted', receivedParts: [] });
    expect(await call('delete', `${BASE}/${id}`)).to.have.status(204);
    expect(Seen.hooks).to.deep.equal([{ hook: 'onAborted', id, status: 'aborted', project: 'p-1' }]);
  });

  it('answers 500 when onCompleted fails, and runs it again on the next complete', async () => {
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;
    for (let n = 1; n <= 3; n++) await sendPart(id, n, partOf(file, n));
    Seen.failCompletions = 1;

    expect((await call('post', `${BASE}/${id}/complete`).send({})).status).to.eq(500);
    expect(await call('post', `${BASE}/${id}/complete`).send({})).to.have.status(200);
    expect(Seen.hooks.map((c) => [c.hook, c.status])).to.deep.equal([
      ['onCompleted', 'completed'],
      ['onCompleted', 'completed'],
    ]);
    expect((await rows('upload_sessions', { id }))[0].handled_at).to.not.eq(null);
  });

  it('keeps the connection of a refused request without a body', async () => {
    const id = bodyOf<UploadStateView>(await createUpload(file)).id;

    const exchange = rawRequest(appPort(), 'GET', `${BASE}/${id}`, { accept: 'application/json', 'x-test-owner': 'alice', 'x-test-deny': 'read' });
    exchange.end();
    const res = await exchange.response;
    expect([res.status, res.headers.connection]).to.deep.equal([403, 'keep-alive']);
  });

  it('creates a session for a name without a known type only when allowUnknownType says so', async () => {
    const res = await createUpload(file, { name: 'blob.unknownext' }, { headers: { 'x-test-unknown-type': 'allow' } });

    expect(res).to.have.status(201);
    expect(bodyOf<UploadStateView>(res)).to.not.have.property('mime');
  });
});
