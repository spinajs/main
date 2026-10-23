import 'mocha';
import { expect } from 'chai';
import { ActionHook } from '@spinajs/hooks';
import type { ActionPattern, BeforeContext } from '@spinajs/hooks';
import { DateTime } from 'luxon';

import type { UploadErrorBody } from '../../src/http/index.js';
import type { UploadStateView } from '../../src/index.js';
import { CaptureQueueClient, emitted } from '../support/capture.js';
import { objectsOf, resetUploads, rows, setSession } from '../support/env.js';
import { text, withHook } from '../support/flow.js';
import { Seen } from './support/calls.js';
import { uploadApp } from './support/app.js';
import { BASE, bodyOf, call, createUpload, digestOf, partOf, sendPart } from './support/client.js';

class CreateHook extends ActionHook<'upload.create'> {
  public readonly actions: readonly ActionPattern[] = ['upload.create'];

  constructor(private readonly onBefore: (ctx: BeforeContext<'upload.create'>) => void) {
    super();
  }

  public before(ctx: BeforeContext<'upload.create'>): void {
    this.onBefore(ctx);
  }
}

function refusal(res: { status: number; body: unknown }, status: number, code: string, details?: object): void {
  expect(res.status, JSON.stringify(res.body)).to.eq(status);
  const body = bodyOf<UploadErrorBody>(res);
  expect(body.code).to.eq(code);
  expect(body.message).to.be.a('string').and.not.eq('');
  if (details) expect(body.details).to.deep.equal(details);
  else expect(body).to.not.have.property('details');
}

describe('UploadController over HTTP: refusals', function () {
  this.timeout(30000);

  const file = text(10);
  const created = async (owner = 'alice', body: Record<string, unknown> = {}): Promise<string> => bodyOf<UploadStateView>(await createUpload(file, body, { owner })).id;
  const deny = (action: string) => ({ headers: { 'x-test-deny': action } });

  before(uploadApp);
  beforeEach(async () => {
    await resetUploads();
    Seen.reset();
  });

  it('answers 404 upload.not_found for another owner session on every route, before authorize', async () => {
    const id = await created('alice');
    Seen.reset();
    CaptureQueueClient.reset();
    const bob = { owner: 'bob' };

    refusal(await call('get', `${BASE}/${id}`, bob), 404, 'upload.not_found');
    expect((await call('head', `${BASE}/${id}`, bob)).status).to.eq(404);
    refusal(await sendPart(id, 1, partOf(file, 1), bob), 404, 'upload.not_found');
    refusal(await call('post', `${BASE}/${id}/complete`, bob).send({}), 404, 'upload.not_found');
    refusal(await call('delete', `${BASE}/${id}`, bob), 404, 'upload.not_found');

    expect(Seen.authorized).to.deep.equal([]);
    expect((await rows('upload_sessions', { id }))[0]).to.include({ status: 'open' });
    expect(await rows('upload_parts', { session_id: id })).to.deep.equal([]);
    expect(await rows('upload_blobs')).to.deep.equal([]);
    expect(objectsOf('temp', `uploads/${id}`)).to.deep.equal([]);
    expect(emitted()).to.deep.equal([]);
  });

  it('answers a missing session exactly like a foreign one', async () => {
    refusal(await call('get', `${BASE}/00000000-0000-4000-8000-000000000000`), 404, 'upload.not_found');

    const id = await created('alice');
    const foreign = await call('get', `${BASE}/${id}`, { owner: 'bob' });
    await resetUploads();
    const missing = await call('get', `${BASE}/${id}`, { owner: 'bob' });
    expect([foreign.status, foreign.body]).to.deep.equal([missing.status, missing.body]);
  });

  it('lets authorize refuse every action on a session with 403, after handing it the owner-scoped session', async () => {
    const id = await created();
    const [before] = await rows('upload_sessions', { id });
    Seen.reset();
    CaptureQueueClient.reset();

    expect((await call('get', `${BASE}/${id}`, deny('read'))).status).to.eq(403);
    expect((await call('head', `${BASE}/${id}`, deny('read'))).status).to.eq(403);
    expect((await sendPart(id, 1, partOf(file, 1), deny('putPart'))).status).to.eq(403);
    expect((await call('post', `${BASE}/${id}/complete`, deny('complete')).send({})).status).to.eq(403);
    expect((await call('delete', `${BASE}/${id}`, deny('abort'))).status).to.eq(403);

    expect(Seen.authorized).to.deep.equal(['read', 'read', 'putPart', 'complete', 'abort'].map((action) => ({ action, session: id })));
    expect(Seen.hooks).to.deep.equal([]);
    expect(await rows('upload_parts', { session_id: id })).to.deep.equal([]);
    expect(await rows('upload_blobs')).to.deep.equal([]);
    expect(await rows('upload_sessions', { id })).to.deep.equal([before]);
    expect(objectsOf('temp', `uploads/${id}`)).to.deep.equal([]);
    expect(objectsOf('files', 'uploads/files')).to.deep.equal([]);
    expect(emitted()).to.deep.equal([]);
  });

  it('lets authorize refuse create with 403 before anything is stored, without a session', async () => {
    expect((await createUpload(file, {}, deny('create'))).status).to.eq(403);

    expect(Seen.authorized).to.deep.equal([{ action: 'create', session: null }]);
    expect(await rows('upload_sessions')).to.deep.equal([]);
    expect(emitted()).to.deep.equal([]);
  });

  it('runs a class policy of the subclass before the action: 403, and authorize never runs', async () => {
    const id = await created();
    Seen.reset();
    const policy = { headers: { 'x-test-policy': 'deny' } };

    expect((await call('get', `${BASE}/${id}`, policy)).status).to.eq(403);
    expect((await createUpload(file, {}, policy)).status).to.eq(403);
    expect(Seen.authorized).to.deep.equal([]);
    expect((await rows('upload_sessions')).map((r) => r.id)).to.deep.equal([id]);
  });

  it('refuses a body that does not fit the DTO with the framework 400, before authorize and the service', async () => {
    expect((await call('post', BASE).send({ name: 'notes.txt' })).status).to.eq(400);
    expect((await call('post', BASE).send({ name: 'notes.txt', size: 10, owner: 'mallory' })).status).to.eq(400);

    expect(Seen.authorized).to.deep.equal([]);
    expect(await rows('upload_sessions')).to.deep.equal([]);
  });

  it('maps the create refusals to their status with { code, message }', async () => {
    refusal(await createUpload(file, { size: 2000 }), 400, 'upload.too_large');
    refusal(await createUpload(file, { partSize: 65 }), 400, 'upload.part_size');
    refusal(await createUpload(file, { name: 'image.png' }), 415, 'upload.unsupported_type');
    refusal(await createUpload(file, { name: 'blob.unknownext' }), 400, 'upload.unsupported_type');
    for (let n = 0; n < 3; n++) expect((await createUpload(file)).status).to.eq(201);
    refusal(await createUpload(file), 429, 'upload.too_many_sessions');
  });

  it('maps the part refusals, and stores nothing', async () => {
    const id = await created();

    refusal(await sendPart(id, 9, partOf(file, 1)), 400, 'upload.part_number');
    refusal(await sendPart(id, 1, partOf(file, 1), { digest: null }), 400, 'upload.digest_required');
    refusal(await sendPart(id, 1, partOf(file, 1), { digest: digestOf(partOf(file, 2)) }), 400, 'upload.part_digest_mismatch');
    refusal(await sendPart(id, 1, Buffer.from('abc')), 400, 'upload.part_size');
    await setSession(id, { expires_at: DateTime.utc().minus({ minutes: 1 }) });
    refusal(await sendPart(id, 1, partOf(file, 1)), 410, 'upload.expired');

    expect(await rows('upload_parts', { session_id: id })).to.deep.equal([]);
    expect(objectsOf('temp', `uploads/${id}`)).to.deep.equal([]);
  });

  it('maps the complete and abort refusals, with the part numbers in details', async () => {
    const id = await created();
    await sendPart(id, 1, partOf(file, 1));
    await sendPart(id, 2, partOf(file, 2));

    refusal(await call('post', `${BASE}/${id}/complete`).send({}), 409, 'upload.parts_missing', { parts: [3] });
    refusal(await call('post', `${BASE}/${id}/complete`).send({ sha256: 'f'.repeat(64) }), 400, 'upload.file_digest_mismatch');
    const undeclared = await created('alice', { sha256: undefined });
    refusal(await call('post', `${BASE}/${undeclared}/complete`).send({}), 400, 'upload.file_digest_required');

    await setSession(id, { status: 'assembling', claim_token: 't', claimed_at: DateTime.utc() });
    refusal(await call('post', `${BASE}/${id}/complete`).send({}), 409, 'upload.assembling');
    refusal(await call('delete', `${BASE}/${id}`), 409, 'upload.assembling');
  });

  it('refuses parts and completion of an aborted session with 409 upload.not_open', async () => {
    const id = await created();
    expect((await call('delete', `${BASE}/${id}`)).status).to.eq(204);

    refusal(await sendPart(id, 1, partOf(file, 1)), 409, 'upload.not_open');
    refusal(await call('post', `${BASE}/${id}/complete`).send({}), 409, 'upload.not_open');
  });

  it('answers a refusing upload.create hook with 403 and the hook code', async () => {
    const res = await withHook(
      new CreateHook((ctx) => ctx.refuse('upload.quota', 'quota exceeded')),
      async () => createUpload(file),
    );

    expect(res.status).to.eq(403);
    expect(bodyOf<UploadErrorBody>(res)).to.deep.equal({ code: 'upload.quota', message: 'quota exceeded' });
    expect(await rows('upload_sessions')).to.deep.equal([]);
  });
});
